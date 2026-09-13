// 运行时 token 热更新回归：把 2026-09-12 那场真实事故（BotFather 吊销 token）的恢复
// 路径固化成「不重启进程」的可执行断言。
//
// 事故当时的恢复手段只有：改 .env → docker compose up -d --force-recreate。
// 这组测试固化新的契约：
//   * token 的第一事实来源是运行时 secret 文件，env 只是 bootstrap / fallback；
//   * 观察到候选值后必须「先 getMe 验证、再原子切换」；
//   * 验证失败/延期绝不破坏当前有效凭据；
//   * 切换只重建 Telegram 入口：PID 不变、uptime 不清零；
//   * **任何时刻最多一个 getUpdates in flight**——这是本文件的核心不变量。
//
// 为什么假 Telegram 必须是「真长轮询」（第二轮修复）：
// 第一版 fake 的 getUpdates 是 `await new Promise(r => setTimeout(r, 60))`：60ms 就返回。
// 于是「旧 loop 还在长轮询时新 loop 启动」这个真正的生产形态从来没被构造出来——旧请求往往
// 在新 loop 启动前就自然返回、inflight 归零，探测不到并发，测试成了假阴性。
// 真实 Telegram 的 getUpdates 是 25s 长轮询，生产里两个 loop 必然长时间并存。
// 现在 fake 的 getUpdates 是**只由 init.signal 中止、或 token 被显式吊销时才结束**的真长轮询
// （不依赖任何固定延时），并把每次请求的
//   getupdates_started / getupdates_aborted / getupdates_finished / inflight / max_inflight
// 按顺序写进 probe 文件。测试在轮换前先证明「旧 getUpdates 已经在飞」，轮换后断言
//   old aborted < old finished < new started 且 max_inflight === 1
// 于是「新请求在旧请求完全退出前启动」只会**确定性失败**，不再看运气。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RuntimeSecretStore, readSecretFile, writeSecretFile } from '../src/runtime/secrets.js';
import { TOKEN_VALIDATION, tokenShapeOk, validateBotToken } from '../src/telegram/ingress.js';

// 形状合法但完全虚构的 token：错误码是刻意的，便于扫描「是否泄漏到日志」。
const TOKEN_A = `1111111111:AA${'a'.repeat(30)}`;
const TOKEN_B = `2222222222:BB${'b'.repeat(30)}`;
const TOKEN_C = `3333333333:CC${'c'.repeat(30)}`;
const TOKEN_D = `4444444444:DD${'d'.repeat(30)}`;
const ANY_TOKEN = /1{10}:AA|2{10}:BB|3{10}:CC|4{10}:DD/;

/** probe 里只出现 token 的 sha256 前缀：既能区分 A/B/C/D，又绝不泄漏 token 本身。 */
function tagOf(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

/**
 * 假 Telegram API（作为子进程的 --import 预加载模块）。
 *
 * 真伪由 state 文件（原子写）决定；getUpdates 是真长轮询：
 *   * 只有 init.signal 中止、或 state.revoke_in_flight 为真且当前 token 已非有效值时才结束；
 *   * 没有「过一会儿自己返回」的行为——这正是生产 25s 长轮询的形态。
 *
 * state 文件字段：
 *   valid            ：唯一被 Telegram 接受的 token（getMe / getUpdates 都按它判）
 *   getme            ：故障注入 ok | 429 | 500 | 503 | network
 *   revoke_in_flight ：true 时长轮询中的失效 token 立刻以 401 结束（复现「吊销 → getUpdates 401」）
 */
function fakeTelegram({ stateFile, probeFile, holdMs = 60_000 }) {
  return `
    import {readFileSync, appendFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';

    const STATE_FILE = ${JSON.stringify(stateFile)};
    const PROBE_FILE = ${JSON.stringify(probeFile)};
    const HOLD_MS = ${holdMs};

    const tag = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
    function state() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
    const validToken = () => { const v = state().valid; return typeof v === 'string' ? v : ''; };

    let seq = 0;
    let requestId = 0;
    let inflight = 0;
    let maxInflight = 0;
    const servedOnce = new Set();

    function probe(payload) {
      appendFileSync(PROBE_FILE, JSON.stringify({seq: ++seq, t: Date.now(), ...payload}) + '\\n');
      console.error('[probe] ' + JSON.stringify(payload));
    }

    // 真长轮询：没有固定时长，只有「被中止」或「被吊销」才结束。
    function longPoll(signal, token) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (outcome) => {
          if (done) return;
          done = true;
          clearInterval(watch);
          clearTimeout(cap);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(outcome);
        };
        const onAbort = () => finish(signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'abort');
        const watch = setInterval(() => {
          if (state().revoke_in_flight === true && validToken() !== token) finish('revoked');
        }, 25);
        const cap = setTimeout(() => finish('hold_expired'), HOLD_MS);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener?.('abort', onAbort, {once: true});
      });
    }

    function abortError(reason) {
      const error = new Error('The operation was aborted');
      error.name = reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      error.cause = reason;
      return error;
    }

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const m = u.match(/\\/bot([^/]+)\\//);
      const token = m ? m[1] : '';

      if (u.includes('/getMe')) {
        const mode = state().getme || 'ok';
        if (mode === 'network') throw Object.assign(new Error('unreachable'), {cause: {code: 'ECONNREFUSED'}});
        if (/^(429|500|503)$/.test(String(mode))) {
          probe({event: 'getme_deferred', tag: tag(token), status: Number(mode)});
          return Response.json({ok: false, error_code: Number(mode), description: 'injected'}, {status: Number(mode)});
        }
        const ok = token === validToken();
        probe({event: ok ? 'getme_ok' : 'getme_rejected', tag: tag(token)});
        return ok
          ? Response.json({ok: true, result: {id: 7777, is_bot: true, username: 'reload_bot'}})
          : Response.json({ok: false, error_code: 401, description: 'Unauthorized'}, {status: 401});
      }

      if (u.includes('/getWebhookInfo')) return Response.json({ok: true, result: {url: '', pending_update_count: 0}});
      if (u.includes('/deleteWebhook')) {
        probe({event: 'delete_webhook', tag: tag(token)});
        return Response.json({ok: true, result: true});
      }

      if (u.includes('/getUpdates')) {
        const id = ++requestId;
        inflight += 1;
        if (inflight > maxInflight) maxInflight = inflight;
        probe({event: 'getupdates_started', id, tag: tag(token), inflight, max_inflight: maxInflight});
        if (inflight > 1) probe({event: 'concurrent_getupdates', id, inflight, max_inflight: maxInflight});

        // 一个 token 的「第一次」长轮询立刻拿到一个空批次：真实 Telegram 在有 pending 更新时
        // 就是这样立刻返回，这也是 /health 从 starting 变成 polling 的唯一来源。
        // 之后的每一次轮询都进入真长轮询：只在 init.signal 中止、token 被吊销、
        // 或 60s 安全上限（现实中是 Telegram 自己的 25s 窗口）时才结束。
        const first = !servedOnce.has(token);
        servedOnce.add(token);
        const before = validToken();
        const outcome = first ? 'delivered' : await longPoll(init?.signal, token);
        inflight -= 1;

        if (outcome === 'abort' || outcome === 'timeout') {
          probe({event: 'getupdates_aborted', id, tag: tag(token), kind: outcome, inflight, max_inflight: maxInflight});
          probe({event: 'getupdates_finished', id, tag: tag(token), outcome, inflight, max_inflight: maxInflight});
          throw abortError(init?.signal?.reason);
        }

        const revoked = token !== validToken() || token !== before;
        probe({
          event: 'getupdates_finished', id, tag: tag(token),
          outcome: revoked ? 'revoked' : outcome, status: revoked ? 401 : 200, inflight, max_inflight: maxInflight,
        });
        if (revoked) return Response.json({ok: false, error_code: 401, description: 'Unauthorized'}, {status: 401});
        return Response.json({ok: true, result: []});
      }

      if (u.includes('/setMyCommands')) {
        probe({event: 'set_my_commands', tag: tag(token)});
        return Response.json({ok: true, result: true});
      }

      return Response.json({ok: true, result: true});
    };
  `;
}

function startBot({ stateFile, probeFile, envToken = TOKEN_A, secretValue = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-secret-'));
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  if (secretValue) writeSecretFile(secretPath, secretValue);
  writeFileSync(probeFile, '');
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fakeTelegram({ stateFile, probeFile }))}`, 'src/main.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MODE: 'poll', PORT: '0', HTTP_HOST: '127.0.0.1',
      AUTH_DIR: dir, CACHE_FILE: join(dir, 'cache.json'),
      BOT_TOKEN_FILE: secretPath,
      BOT_TOKEN_POLL_MS: '120',
      ...(envToken ? { BOT_TOKEN: envToken } : { BOT_TOKEN: '' }),
      WEBHOOK_SECRET: 'regression-webhook-secret',
      HTTP_PROXY: '', HTTPS_PROXY: '', PUBLIC_BASE_URL: '', DA_REFRESH_TOKEN: '', DA_COOKIES: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { output += b; const m = output.match(/127\.0\.0\.1:(\d+) \(mode=poll\)/); if (m) resolve(m[1]); });
    child.stderr.on('data', (b) => { output += b; });
    child.once('exit', () => reject(new Error('进程在 /health 可用前退出（这正是崩溃循环症状）')));
  });
  return {
    child, ready, dir, secretPath, stateFile, probeFile,
    pid: child.pid,
    get output() { return output; },
    health: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).json(),
    writeSecret: (value) => writeSecretFile(secretPath, value),
    /** 原子 rename 之外的第二种写法：直接落到临时文件再 mv（模拟文档里的手工步骤）。 */
    renameSecret: (value, suffix = 'manual') => {
      const tmp = `${secretPath}.${suffix}.tmp`;
      mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, value, { mode: 0o600 });
      renameSync(tmp, secretPath);
    },
    probes: () => readProbes(probeFile),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

async function waitFor(predicate, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`超时未满足：${label}`);
}

const readStateFile = (stateFile) => {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; }
};

/** 原子写 state：子进程每个请求都会读它，半截 JSON 会变成假故障。 */
function setState(stateFile, next) {
  const tmp = `${stateFile}.next`;
  writeFileSync(tmp, JSON.stringify({ ...readStateFile(stateFile), ...next }));
  renameSync(tmp, stateFile);
}

function setValid(stateFile, token) { setState(stateFile, { valid: token }); }

// —— probe 解析与不变量断言 ——

function readProbes(probeFile) {
  let text = '';
  try { text = readFileSync(probeFile, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; } // 忽略正在写的最后半行
  });
}

/** 还没有 aborted/finished 的 getUpdates 请求 = 此刻真正在飞的 loop。 */
function liveGetUpdates(probes) {
  const ended = new Set(
    probes.filter((p) => p.event === 'getupdates_aborted' || p.event === 'getupdates_finished').map((p) => p.id),
  );
  return probes.filter((p) => p.event === 'getupdates_started' && !ended.has(p.id));
}

/** 轮换前先证明「旧 getUpdates 已经在飞」——不然测的就不是长轮询形态。 */
async function waitForInflight(bot, { tag, timeout = 8000 }) {
  let found = null;
  await waitFor(() => {
    // 单次快照判定：必须**恰好一个** in-flight 且是本代 token。
    // 两个 = 旧 loop 没退出（这正是要抓的 bug）；零个 = 换代的空档，继续等。
    const live = liveGetUpdates(bot.probes());
    found = live.length === 1 && live[0].tag === tag ? live[0] : null;
    return found !== null;
  }, { timeout, label: `tag=${tag} 的 getUpdates 必须恰好一个 in-flight` });
  return found;
}

function startedProbes(probes) { return probes.filter((p) => p.event === 'getupdates_started'); }
function byId(probes, event, id) { return probes.find((p) => p.event === event && p.id === id); }
function countEvents(output, name) { return output.split(`"event":"${name}"`).length - 1; }

/**
 * 单 loop 不变量的全部判据（每个 e2e 用例末尾都要过一遍）：
 *   1. 从未出现 inflight >= 2（也没有 concurrent_getupdates 探测事件）；
 *   2. 全局 max_inflight === 1；
 *   3. 严格串行：任何新请求启动前，上一个请求必须已经 finished；
 *   4. 每个请求都闭合：finished 时 inflight 归零，且 aborted 一定早于 finished。
 */
function assertSingleGetUpdates(probes, label) {
  const starts = startedProbes(probes);
  assert.ok(starts.length > 0, `${label}: 没有任何 getUpdates 请求`);
  assert.equal(probes.filter((p) => p.event === 'concurrent_getupdates').length, 0, `${label}: 出现并发 getUpdates`);
  const maxInflight = Math.max(0, ...probes.map((p) => p.max_inflight ?? 0));
  assert.equal(maxInflight, 1, `${label}: max getUpdates in flight 必须是 1，实测 ${maxInflight}`);

  for (const start of starts) {
    assert.equal(start.inflight, 1, `${label}: 请求 ${start.id} 启动时 inflight 必须是 1`);
  }
  for (let i = 1; i < starts.length; i += 1) {
    const previous = starts[i - 1];
    const next = starts[i];
    const finished = byId(probes, 'getupdates_finished', previous.id);
    assert.ok(finished, `${label}: 请求 ${previous.id} 没有 finished 事件（loop/Promise 没退出）`);
    assert.ok(finished.seq < next.seq, `${label}: 新 getUpdates(${next.id}) 在旧请求(${previous.id})完全退出前就启动了`);
  }
  for (const start of starts) {
    const aborted = byId(probes, 'getupdates_aborted', start.id);
    const finished = byId(probes, 'getupdates_finished', start.id);
    // 唯一允许「还没闭合」的就是此刻正在飞的那一个：其它请求都必须有 finished。
    if (liveGetUpdates(probes).some((p) => p.id === start.id)) continue;
    assert.ok(finished, `${label}: 请求 ${start.id} 未闭合`);
    assert.equal(finished.inflight, 0, `${label}: 请求 ${start.id} finished 时 inflight 必须归零`);
    if (aborted) assert.ok(aborted.seq < finished.seq, `${label}: 请求 ${start.id} 的 aborted 必须早于 finished`);
  }
}

/**
 * 一次轮换的严格顺序断言：
 *   old aborted < old finished < 第一个新 getUpdates started
 * 并且轮换之后不允许任何**旧 token** 的 getUpdates 再启动（旧 loop 真的没了）。
 * @returns {object} 新 token 的第一个 getUpdates 探测事件
 */
function assertRotationOrdering(probes, { oldId, newTag, label }) {
  const start = startedProbes(probes).find((p) => p.id === oldId);
  const aborted = byId(probes, 'getupdates_aborted', oldId);
  const finished = byId(probes, 'getupdates_finished', oldId);
  assert.ok(aborted, `${label}: 旧 getUpdates(${oldId}) 必须被 abort——旧 loop 被中止后才算退出`);
  assert.equal(aborted.kind, 'abort', `${label}: 旧请求必须是被轮换中止的，而不是超时/自然结束`);
  assert.ok(finished, `${label}: 旧 getUpdates(${oldId}) 必须 finished`);
  assert.ok(aborted.seq < finished.seq, `${label}: 必须先 aborted 再 finished`);
  const after = startedProbes(probes).filter((p) => p.seq > finished.seq);
  assert.ok(after.length > 0, `${label}: 轮换后必须有新的 getUpdates 启动`);
  assert.ok(start.seq < after[0].seq, `${label}: 新 getUpdates 必须在旧请求完全退出之后启动`);
  assert.equal(after[0].tag, newTag, `${label}: 轮换后第一个 getUpdates 必须用新 token`);
  for (const probe of after) {
    assert.equal(probe.tag, newTag, `${label}: 旧 token 的 loop 在轮换后不得继续轮询`);
  }
  return after[0];
}

// —— 纯单元：验证分类（§17）与 store 的原子/删除语义（§7/§8） ——

test('token shape check rejects malformed values without any network call', () => {
  assert.equal(tokenShapeOk(TOKEN_A), true);
  assert.equal(tokenShapeOk('not-a-token'), false);
  assert.equal(tokenShapeOk('123:short'), false);
  assert.equal(tokenShapeOk(''), false);
});

test('validateBotToken: only a definite 200+ok is valid; 429/5xx/network are deferred', async () => {
  const ok = await validateBotToken(TOKEN_A, { fetchImpl: async () => Response.json({ ok: true, result: { id: 5, username: 'u' } }) });
  assert.equal(ok.status, TOKEN_VALIDATION.VALID);
  assert.equal(ok.botId, 5);
  assert.equal(ok.botUsername, 'u');

  const unauthorized = await validateBotToken(TOKEN_A, {
    fetchImpl: async () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 }),
  });
  assert.equal(unauthorized.status, TOKEN_VALIDATION.INVALID);

  for (const [status, label] of [[429, 'rate_limited'], [500, 'telegram_unavailable'], [503, 'telegram_unavailable']]) {
    const deferred = await validateBotToken(TOKEN_A, { fetchImpl: async () => Response.json({ ok: false }, { status }) });
    assert.equal(deferred.status, TOKEN_VALIDATION.DEFERRED, `HTTP ${status} 必须是延期而不是判死`);
    assert.equal(deferred.reason, label);
  }

  const timeout = await validateBotToken(TOKEN_A, { fetchImpl: async () => { throw Object.assign(new Error('timeout'), { cause: { code: 'ETIMEDOUT' } }); } });
  assert.equal(timeout.status, TOKEN_VALIDATION.DEFERRED);
  assert.equal(timeout.reason, 'ETIMEDOUT');

  // 形态不合法：直接判无效，不打网络。
  let called = false;
  const malformed = await validateBotToken('garbage', { fetchImpl: async () => { called = true; return Response.json({ ok: true }); } });
  assert.equal(malformed.status, TOKEN_VALIDATION.INVALID);
  assert.equal(called, false);
});

test('store: file wins over env, env is only a seed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-store-'));
  try {
    const path = join(dir, 'telegram-bot-token');
    const fromEnv = new RuntimeSecretStore({ name: 't', path, envValue: TOKEN_A });
    assert.equal(fromEnv.value, TOKEN_A);
    assert.equal(fromEnv.source, 'env');

    writeSecretFile(path, TOKEN_B);
    const fromFile = new RuntimeSecretStore({ name: 't', path, envValue: TOKEN_A });
    assert.equal(fromFile.value, TOKEN_B);
    assert.equal(fromFile.source, 'file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: an invalid candidate never replaces the working value, a deferred one is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-store-'));
  try {
    const path = join(dir, 'telegram-bot-token');
    writeSecretFile(path, TOKEN_A);
    const store = new RuntimeSecretStore({ name: 't', path });
    const seen = [];
    let mode = 'invalid';
    store.subscribe(async (candidate) => {
      seen.push(candidate);
      if (mode === 'deferred') return { ok: false, defer: true, reason: 'rate_limited' };
      return { ok: false, reason: 'invalid_token' };
    });

    writeSecretFile(path, TOKEN_B);
    await store.check();
    assert.equal(store.value, TOKEN_A, '被拒绝的候选值不得生效');
    assert.equal(store.state, 'rejected');
    assert.equal(store.lastValidation, 'invalid');

    // 同一份被拒绝的内容不会反复重验。
    await store.check();
    assert.equal(seen.length, 1);

    // 延期：不提交、也不作废候选，退避后重试同一个值。
    mode = 'deferred';
    writeSecretFile(path, TOKEN_C);
    await store.check();
    assert.equal(store.value, TOKEN_A);
    assert.equal(store.lastValidation, 'deferred');
    assert.equal(store.state, 'loaded', '延期时 /health 不能因为一次网络抖动变红');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: deleting the secret keeps the last verified value and marks the source stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-store-'));
  try {
    const path = join(dir, 'telegram-bot-token');
    writeSecretFile(path, TOKEN_A);
    const store = new RuntimeSecretStore({ name: 't', path });
    rmSync(path, { force: true });
    await store.check();
    assert.equal(store.value, TOKEN_A, '删文件不等于撤销凭据');
    assert.equal(store.state, 'stale');
    assert.equal(store.source, 'file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: an empty candidate is ignored instead of clearing a valid runtime credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-store-'));
  try {
    const path = join(dir, 'telegram-bot-token');
    writeSecretFile(path, TOKEN_A);
    const store = new RuntimeSecretStore({ name: 't', path });
    store.subscribe(async () => ({ ok: true }));
    writeSecretFile(path, '');
    const result = await store.check();
    assert.equal(result.reason, 'empty');
    assert.equal(store.value, TOKEN_A);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: an atomic rename is detected (ino changes, not just mtime)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-store-'));
  try {
    const path = join(dir, 'telegram-bot-token');
    writeSecretFile(path, TOKEN_A);
    const store = new RuntimeSecretStore({ name: 't', path });
    store.subscribe(async () => ({ ok: true, botUsername: 'reload_bot' }));
    const tmp = `${path}.manual.tmp`;
    writeFileSync(tmp, TOKEN_D, { mode: 0o600 });
    renameSync(tmp, path);
    const result = await store.check();
    assert.equal(result.applied, true);
    assert.equal(store.value, TOKEN_D);
    assert.equal(readSecretFile(path), TOKEN_D);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// —— 端到端：真实子进程 + 长轮询假 Telegram API ——

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'dd-state-'));
  return { dir, stateFile: join(dir, 'telegram-state.json'), probeFile: join(dir, 'probe.ndjson') };
}

test('bootstrap: env token starts the bot, and a secret file takes priority over env', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_B);

  // env 里放 A，文件里放 B：B 才有效 → 只有「文件优先」才能 ok。
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A, secretValue: TOKEN_B });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'file token 生效' });
  await waitForInflight(bot, { tag: tagOf(TOKEN_B) });

  const health = await bot.health(port);
  assert.equal(health.status, 'ok');
  assert.equal(health.components.telegram_bot.state, '@reload_bot');
  assert.equal(health.runtime_secrets.telegram_bot_token.source, 'file');
  assert.equal(health.runtime_secrets.telegram_bot_token.reloadable, true);
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'loaded');
  // 启动就只有一个 loop。
  assertSingleGetUpdates(bot.probes(), 'bootstrap');
  // 元数据里没有值本身。
  assert.doesNotMatch(JSON.stringify(health.runtime_secrets), ANY_TOKEN);
  assert.doesNotMatch(readFileSync(probeFile, 'utf8'), ANY_TOKEN);
});

// 回归 1：A(valid) -> B(valid)。
test('rotation 1: A -> B aborts the old long poll before the new loop starts', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  const before = await bot.health(port);

  // 前置条件：旧 loop 的 getUpdates 必须已经 in-flight（否则测不到长轮询形态）。
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });

  setValid(stateFile, TOKEN_B);
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_applied"'), { label: 'reload applied' });
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.last_validation === 'ok', { label: 'health 记录验证成功' });
  const nextInFlight = await waitForInflight(bot, { tag: tagOf(TOKEN_B) });
  const after = await bot.health(port);

  const probes = bot.probes();
  const next = assertRotationOrdering(probes, { oldId: old.id, newTag: tagOf(TOKEN_B), label: 'A->B' });
  assert.equal(nextInFlight.tag, tagOf(TOKEN_B));
  assert.ok(nextInFlight.seq >= next.seq);
  assertSingleGetUpdates(probes, 'A->B');
  assert.deepEqual([...new Set(startedProbes(probes).map((p) => p.tag))], [tagOf(TOKEN_A), tagOf(TOKEN_B)], '每个 loop 只用自己那一代的 token');
  assert.equal(liveGetUpdates(probes).length, 1, '轮换结束后只剩一个在飞的 getUpdates');
  // 新 loop 启动之后才注册命令。
  const commands = probes.find((p) => p.event === 'set_my_commands' && p.tag === tagOf(TOKEN_B));
  assert.ok(commands, '新 token 必须重注册命令菜单');
  assert.ok(commands.seq > next.seq, '命令注册必须发生在新 loop 启动之后');

  assert.equal(after.status, 'ok');
  assert.equal(after.components.telegram_ingress.state, 'polling');
  assert.equal(after.counters.telegram_conflict ?? 0, 0);
  assert.equal(after.runtime_secrets.telegram_bot_token.source, 'file');
  assert.ok(after.runtime_secrets.telegram_bot_token.last_reload);
  assert.match(bot.output, /"event":"telegram_credential_swapped"/);
  assert.match(bot.output, /"event":"telegram_ingress_restarted"/);
  assert.equal(countEvents(bot.output, 'telegram_ingress_restarted'), 2, '一次轮换只重建一次入口');
  // 关键：进程从未重启。
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
  assert.ok(after.uptime_s >= before.uptime_s, '进程没有重启，uptime 必须继续累积');
  assert.equal(after.started_at, before.started_at);
  // 日志里没有 token。
  assert.doesNotMatch(bot.output, ANY_TOKEN);
  assert.doesNotMatch(readFileSync(probeFile, 'utf8'), ANY_TOKEN);
});

// 回归 2：A -> B -> C -> D 连续轮换，每轮严格串行。
test('rotation 2: A -> B -> C -> D stays serial every round, with no leaked loop', { timeout: 60000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  const chain = [TOKEN_B, TOKEN_C, TOKEN_D];
  let current = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });

  for (const token of chain) {
    const applied = countEvents(bot.output, 'secret_reload_applied');
    setValid(stateFile, token);
    bot.writeSecret(token);
    await waitFor(async () => countEvents(bot.output, 'secret_reload_applied') > applied, { label: `切换到 ${tagOf(token)}` });
    // 每一轮都重新验一遍严格顺序：abort -> finish -> start，且轮换后不再出现旧 token。
    assertRotationOrdering(bot.probes(), { oldId: current.id, newTag: tagOf(token), label: `->${tagOf(token)}` });
    assertSingleGetUpdates(bot.probes(), `->${tagOf(token)}`);
    current = await waitForInflight(bot, { tag: tagOf(token) });
  }

  await waitFor(async () => (await bot.health(port)).counters.telegram_ingress_restarts >= 4, { label: '4 次入口重建' });
  const health = await bot.health(port);
  const probes = bot.probes();
  assert.equal(health.status, 'ok');
  assert.equal(health.components.telegram_ingress.state, 'polling');
  // 1 次启动 + 3 次轮换 = 4 个 loop，且它们严格串行。
  assert.equal(health.counters.telegram_ingress_restarts, 4, '不能多也不能少：多一个就是 loop 泄漏');
  assert.equal(health.counters.telegram_conflict ?? 0, 0, '冲突计数必须保持 0');
  assert.equal(probes.filter((p) => p.event === 'concurrent_getupdates').length, 0);
  // 每次轮换恰好 abort 一个 getUpdates（= 恰好一个旧 loop 退出），没有第二个 loop 被漏掉。
  assert.equal(probes.filter((p) => p.event === 'getupdates_aborted').length, 3);
  assert.deepEqual(
    [...new Set(startedProbes(probes).map((p) => p.tag))],
    [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D].map(tagOf),
    '每次轮换只推进一代 token',
  );
  // 代数只增不减：出现 B 之后不允许再有 A 的请求（= 旧 loop 没有残留）。
  const rank = new Map([TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D].map((t, i) => [tagOf(t), i]));
  const ranks = startedProbes(probes).map((p) => rank.get(p.tag));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'token 代数必须单调不减');
  assert.deepEqual(liveGetUpdates(probes).map((p) => p.tag), [tagOf(TOKEN_D)], '最终只允许一个在飞的 getUpdates');
  assertSingleGetUpdates(probes, 'A->D');
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
  assert.doesNotMatch(readFileSync(probeFile, 'utf8'), ANY_TOKEN);
});

// 回归 3：真实事故模型——运行中吊销 A（getUpdates 401），随后热更新有效 B。
test('rotation 3: revoked A returns 401, then a hot-reloaded B takes over the single loop', { timeout: 45000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });
  const startedAtBefore = (await bot.health(port)).started_at;

  // 运行中吊销 A：Telegram 只认 B，且正在长轮询的 A 立刻以 401 结束。
  setState(stateFile, { valid: TOKEN_B, revoke_in_flight: true });
  await waitFor(() => bot.probes().some((p) => p.event === 'getupdates_finished' && p.id === old.id && p.status === 401), {
    label: '旧 getUpdates 收到 401',
  });
  await waitFor(async () => (await bot.health(port)).status === 'degraded', { label: 'degraded' });
  const degraded = await bot.health(port);
  assert.equal(degraded.components.telegram_auth.state, 'unauthorized');
  assert.ok(degraded.degraded.includes('telegram_auth'));
  assert.equal(bot.child.exitCode, null, '401 不得杀死进程');

  // 不重启任何东西：只把新 token 原子写进运行时 secret。
  bot.renameSecret(TOKEN_B, 'bootstrap');
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: '热恢复为 ok' });
  const next = await waitForInflight(bot, { tag: tagOf(TOKEN_B) });

  const recovered = await bot.health(port);
  const probes = bot.probes();
  // 事故链：旧请求是「被 Telegram 401 结束」的，新请求必须在它之后才启动。
  const oldFinished = byId(probes, 'getupdates_finished', old.id);
  assert.equal(oldFinished.outcome, 'revoked');
  assert.equal(oldFinished.status, 401);
  assert.equal(next.tag, tagOf(TOKEN_B));
  assert.ok(oldFinished.seq < next.seq, '新 loop 必须在旧 loop 完全退出之后启动');
  assertSingleGetUpdates(probes, 'revoked->B');
  assert.deepEqual([...new Set(startedProbes(probes).map((p) => p.tag))], [tagOf(TOKEN_A), tagOf(TOKEN_B)], '被吊销的 A loop 不得继续轮询');
  assert.deepEqual(liveGetUpdates(probes).map((p) => p.tag), [tagOf(TOKEN_B)], '恢复后只有一个在飞的 getUpdates');

  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.components.telegram_auth.state, 'ok');
  assert.equal(recovered.components.telegram_bot.state, '@reload_bot');
  assert.equal(recovered.components.telegram_ingress.state, 'polling');
  assert.equal(recovered.counters.telegram_conflict ?? 0, 0, '整个过程不允许出现 409 冲突');
  assert.match(bot.output, /"event":"telegram_auth_recovered"/);
  // 核心验收：PID 不变、进程没有重启。
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
  assert.equal(recovered.started_at, startedAtBefore, '同一进程：started_at 必须完全一致');
  assert.ok(recovered.uptime_s >= degraded.uptime_s);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
  assert.doesNotMatch(readFileSync(probeFile, 'utf8'), ANY_TOKEN);
});

// 回归 4：无效候选值绝不打断当前 loop。
test('rotation 4: an invalid new token is rejected and the running loop is left alone', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  const before = await bot.health(port);
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });
  const startsBefore = startedProbes(bot.probes()).length;

  // 误写一个无效 token：state 仍是 A，所以 B 会被 Telegram 拒绝。
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_rejected"'), { label: 'rejected' });

  const health = await bot.health(port);
  const probes = bot.probes();
  assert.equal(health.status, 'ok', 'A 仍然有效：health 必须保持 ok');
  assert.equal(health.components.telegram_auth.state, 'ok');
  assert.equal(health.components.telegram_ingress.state, 'polling');
  assert.equal(health.runtime_secrets.telegram_bot_token.last_validation, 'invalid');
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'rejected');
  assert.match(bot.output, /"event":"secret_reload_rejected","ts":"[^"]+","name":"telegram_bot_token","reason":"invalid_token"/);
  assert.doesNotMatch(bot.output, /"event":"telegram_credential_swapped"/, '被拒绝的候选值绝不能切换');
  // 关键：旧 loop 既没被 abort，也没有新 loop 被创建。
  assert.equal(countEvents(bot.output, 'telegram_ingress_restarted'), 1, '无效候选值不得触发入口重建');
  assert.equal(health.counters.telegram_ingress_restarts, 1);
  assert.equal(byId(probes, 'getupdates_aborted', old.id), undefined, '不得 abort 正在工作的 loop');
  assert.equal(startedProbes(probes).length, startsBefore, '不得创建新 loop');
  assert.deepEqual(liveGetUpdates(probes).map((p) => p.id), [old.id], '原来那个请求必须还在飞');
  assertSingleGetUpdates(probes, 'invalid candidate');
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(health.started_at, before.started_at);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

// 回归 5：deferred validation（429 / 5xx / network）不动当前入口。
// 三种注入各起一个进程，避免撞上 store 的 10s 退避窗口（退避语义另由 §store 单测覆盖）。
for (const [mode, reason, httpStatus] of [['429', 'rate_limited', 429], ['500', 'telegram_unavailable', 500], ['network', 'ECONNREFUSED', null]]) {
  test(`rotation 5: a ${mode} getMe is deferred and never rebuilds the running ingress`, { timeout: 60000 }, async (t) => {
    const { stateFile, probeFile } = scenario();
    setValid(stateFile, TOKEN_A);
    const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
    t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
    const port = await bot.ready;
    await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
    const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });

    // Telegram 暂时不可用（state.valid 已经是 B：这里验证「验证没成功 ⇒ 什么都不动」）。
    setState(stateFile, { valid: TOKEN_B, getme: mode });
    bot.writeSecret(TOKEN_B);
    await waitFor(async () => bot.output.includes('"event":"secret_reload_deferred"'), { label: `${mode} deferred` });
    assert.match(bot.output, new RegExp(`"event":"secret_reload_deferred"[^]*?"reason":"${reason}"`), `延期原因必须是 ${reason}`);

    // 当前 loop 完全不受影响：没有 abort、没有新 loop、没有入口重建、health 依旧 ok。
    const probes = bot.probes();
    const health = await bot.health(port);
    assert.equal(countEvents(bot.output, 'telegram_ingress_restarted'), 1, '延期不得触发入口重建');
    assert.equal(countEvents(bot.output, 'telegram_credential_swapped'), 0, '延期不得提交候选值');
    assert.equal(health.counters.telegram_ingress_restarts, 1);
    assert.equal(byId(probes, 'getupdates_aborted', old.id), undefined, '延期不得 abort 正在工作的 loop');
    assert.deepEqual(liveGetUpdates(probes).map((p) => p.id), [old.id]);
    assert.equal(health.status, 'ok', '一次网络抖动不能让 /health 变红');
    assert.equal(health.components.telegram_ingress.state, 'polling');
    assert.equal(health.runtime_secrets.telegram_bot_token.last_validation, 'deferred');
    if (httpStatus) assert.equal(health.runtime_secrets.telegram_bot_token.last_reason, reason);

    // 退避窗口过去后，同一个候选值仍然能被验证并正常轮换（延期不等于判死）。
    setState(stateFile, { getme: 'ok' });
    await waitFor(async () => bot.output.includes('"event":"secret_reload_applied"'), { timeout: 25000, label: '退避后重试成功' });
    const next = await waitForInflight(bot, { tag: tagOf(TOKEN_B) });
    const after = bot.probes();
    assert.equal(byId(after, 'getupdates_aborted', old.id)?.kind, 'abort');
    assert.ok(byId(after, 'getupdates_finished', old.id).seq < next.seq);
    assertSingleGetUpdates(after, `${mode} deferred -> rotated`);
    assert.equal((await bot.health(port)).status, 'ok');
    assert.equal(bot.child.pid, bot.pid);
    assert.doesNotMatch(bot.output, ANY_TOKEN);
    assert.doesNotMatch(readFileSync(probeFile, 'utf8'), ANY_TOKEN);
  });
}

// 回归 6：手工 tmp + mv（原子 rename）写 secret，单 loop 不变量同样成立。
test('rotation 6: a hand-written tmp+mv rename keeps the single-getUpdates invariant', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  // 第一次用 env 启动：文件出现后 source 必须迁移到 file。
  assert.equal((await bot.health(port)).runtime_secrets.telegram_bot_token.source, 'env');
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });
  bot.renameSecret(TOKEN_A, 'same-value');
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.source === 'file', { label: 'source 迁移到 file' });
  assert.match(bot.output, /"event":"secret_source_migrated"/);
  assert.equal(countEvents(bot.output, 'telegram_ingress_restarted'), 1, '同值迁移不重建入口');
  assert.equal(liveGetUpdates(bot.probes())[0].id, old.id, '同值迁移不得动 loop');

  // 真正的轮换：原子 rename 一个有效的新 token。
  setValid(stateFile, TOKEN_C);
  bot.renameSecret(TOKEN_C);
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.bot_username === 'reload_bot', { label: 'rename 被识别' });
  assert.match(bot.output, /"event":"secret_reload_applied"/);
  await waitForInflight(bot, { tag: tagOf(TOKEN_C) });
  const probes = bot.probes();
  assertRotationOrdering(probes, { oldId: old.id, newTag: tagOf(TOKEN_C), label: 'rename A->C' });
  assertSingleGetUpdates(probes, 'rename A->C');
  assert.equal(liveGetUpdates(probes).length, 1);
  assert.equal((await bot.health(port)).counters.telegram_conflict ?? 0, 0);
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
});

test('secret 9: deleting the secret file keeps serving with the last verified token', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_B);
  const bot = startBot({ stateFile, probeFile, envToken: null, secretValue: TOKEN_B });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'B 生效' });
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_B) });

  rmSync(bot.secretPath, { force: true });
  await waitFor(async () => bot.output.includes('"event":"secret_source_missing"'), { label: 'source missing' });

  const health = await bot.health(port);
  assert.equal(health.status, 'ok', '删文件不等于撤销：最后一次已验证的 token 继续有效');
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'stale');
  assert.equal(bot.child.exitCode, null);
  assert.equal(countEvents(bot.output, 'telegram_ingress_restarted'), 1, '删文件不得重建入口');
  assert.deepEqual(liveGetUpdates(bot.probes()).map((p) => p.id), [old.id], '正在跑的 loop 不受影响');
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('secret 16: reload failures never crash the process (bad file, unreadable dir, invalid content)', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  const old = await waitForInflight(bot, { tag: tagOf(TOKEN_A) });

  // 先把来源迁移到文件，后续的文件级故障才有意义。
  bot.renameSecret(TOKEN_A, 'migrate');
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.source === 'file', { label: 'source=file' });

  // 一段垃圾内容（形态不合法）→ 拒绝，不崩。
  bot.writeSecret('definitely-not-a-token');
  await waitFor(async () => bot.output.includes('"event":"secret_reload_rejected"'), { label: 'malformed rejected' });
  assert.equal(bot.child.exitCode, null);

  // 一个目录顶替文件（读失败 / EISDIR）→ 记录事件，不崩。
  rmSync(bot.secretPath, { force: true });
  mkdirSync(bot.secretPath, { recursive: true });
  await waitFor(async () => bot.output.includes('"event":"secret_source_missing"') || bot.output.includes('"event":"secret_reload_unreadable"'), { label: '目录不致命' });
  assert.equal(bot.child.exitCode, null);

  const health = await bot.health(port);
  assert.equal(health.status, 'ok', 'A 仍然有效');
  assert.doesNotMatch(bot.output, /"event":"process_uncaught_exception"/);
  assert.doesNotMatch(bot.output, /"event":"process_unhandled_rejection"/);
  assert.deepEqual(liveGetUpdates(bot.probes()).map((p) => p.id), [old.id], '文件故障不得重建入口');
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('secret 10: no token ever reaches health, events, stdout, stderr or the probe log', { timeout: 40000 }, async (t) => {
  const { stateFile, probeFile } = scenario();
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, probeFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  await waitForInflight(bot, { tag: tagOf(TOKEN_A) });

  setValid(stateFile, TOKEN_B);
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_applied"'), { label: 'B applied' });
  await waitForInflight(bot, { tag: tagOf(TOKEN_B) });
  bot.writeSecret('9999999999:ZZ' + 'z'.repeat(30));
  await waitFor(async () => countEvents(bot.output, 'secret_reload_rejected') >= 1, { label: 'invalid rejected' });

  const healthText = JSON.stringify(await bot.health(port));
  const probeText = readFileSync(probeFile, 'utf8');
  for (const text of [healthText, bot.output, probeText]) {
    assert.doesNotMatch(text, ANY_TOKEN);
    assert.doesNotMatch(text, /9{10}:ZZ/);
    assert.doesNotMatch(text, /api\.telegram\.org\/bot/);
  }
});

// —— CLI 层：用户实际会敲的那条命令 ——

function runCli({ stateFile, probeFile, secretPath, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(fakeTelegram({ stateFile, probeFile }))}`,
      'scripts/dd-token.mjs', 'set', 'telegram',
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, BOT_TOKEN_FILE: secretPath, DD_HEALTH_URL: 'http://127.0.0.1:1/health' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.once('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('CLI: set telegram writes the secret atomically with 0600 and no echo of the value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-cli-'));
  const stateFile = join(dir, 'telegram-state.json');
  const probeFile = join(dir, 'probe.ndjson');
  setValid(stateFile, TOKEN_D);
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  try {
    const { code, out } = await runCli({ stateFile, probeFile, secretPath, input: TOKEN_D });
    assert.equal(code, 0, out);
    assert.equal(readSecretFile(secretPath), TOKEN_D);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600, 'secret 文件必须是 0600');
    assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700, '目录必须是 0700');
    // 输出的任何一行都不含 token 本身（只有形状提示与是否通过）。
    assert.doesNotMatch(out, ANY_TOKEN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: refuses a token Telegram rejects, and never writes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-cli-'));
  const stateFile = join(dir, 'telegram-state.json');
  const probeFile = join(dir, 'probe.ndjson');
  setValid(stateFile, TOKEN_A);           // B 不在白名单 → getMe 会 401
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  try {
    const rejected = await runCli({ stateFile, probeFile, secretPath, input: TOKEN_B });
    assert.equal(rejected.code, 1);
    assert.equal(readSecretFile(secretPath), null, '被拒绝的 token 不得落盘');
    assert.doesNotMatch(rejected.out, ANY_TOKEN);

    // 形态不合法：连网络都不打。
    const malformed = await runCli({ stateFile, probeFile, secretPath, input: 'not-a-token' });
    assert.equal(malformed.code, 1);
    assert.match(malformed.out, /形状不合法/);
    assert.equal(readSecretFile(secretPath), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: writes through a transient network failure (validation deferred) and lets the service decide', async () => {
  // 注意：Node 的 fetch（undici）不读 HTTP_PROXY 环境变量，所以用注入的 fetch 模拟
  // 「验证时网络不可达」。契约是：网络问题不等于 token 错——仍然写入，由服务自行复核。
  const dir = mkdtempSync(join(tmpdir(), 'dd-cli-'));
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  const brokenFetch = `globalThis.fetch=async()=>{throw Object.assign(new Error('unreachable'),{cause:{code:'ECONNREFUSED'}})};`;
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(brokenFetch)}`,
    'scripts/dd-token.mjs', 'set', 'telegram',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOT_TOKEN_FILE: secretPath, DD_HEALTH_URL: 'http://127.0.0.1:1/health' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  try {
    child.stdin.end(TOKEN_C);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, out);
    assert.equal(readSecretFile(secretPath), TOKEN_C, '网络暂不可达不应该阻止写入');
    assert.match(out, /暂时无法验证/);
    assert.doesNotMatch(out, ANY_TOKEN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
