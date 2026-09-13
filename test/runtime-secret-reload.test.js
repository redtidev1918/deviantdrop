// 运行时 token 热更新回归：把 2026-09-12 那场真实事故（BotFather 吊销 token）的恢复
// 路径固化成「不重启进程」的可执行断言。
//
// 事故当时的恢复手段只有：改 .env → docker compose up -d --force-recreate。
// 这组测试固化新的契约：
//   * token 的第一事实来源是运行时 secret 文件，env 只是 bootstrap / fallback；
//   * 观察到候选值后必须「先 getMe 验证、再原子切换」；
//   * 验证失败/延期绝不破坏当前有效凭据；
//   * 切换只重建 Telegram 入口：PID 不变、uptime 不清零、最多一个 poll loop。
//
// 用的是一张可切换真伪的假 Telegram API：它在 getMe 时读一个 state 文件，
// 只有与 state 文件一致的 token 才算有效——于是测试可以在运行中「吊销」或
// 「重新签发」token，完全复现真实事故的时间线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * 假 Telegram API。真伪由 state 文件决定；同时并行计数 getUpdates，
 * 一旦出现两个 loop 同时长轮询就写一行 probe 事件（父进程据此断言）。
 */
function fakeTelegram(stateFile) {
  return `
    import {readFileSync} from 'node:fs';
    const stateFile=${JSON.stringify(stateFile)};
    const valid=()=>{try{return readFileSync(stateFile,'utf8').trim()}catch{return ''}};
    let inflight=0;
    globalThis.fetch=async(url,init)=>{
      const u=String(url);
      const m=u.match(/\\/bot([^/]+)\\//);
      const token=m?m[1]:'';
      if(u.includes('/getMe')){
        return token===valid()
          ?Response.json({ok:true,result:{id:7777,is_bot:true,username:'reload_bot'}})
          :Response.json({ok:false,error_code:401,description:'Unauthorized'},{status:401});
      }
      if(u.includes('/getWebhookInfo'))return Response.json({ok:true,result:{url:'',pending_update_count:0}});
      if(u.includes('/deleteWebhook'))return Response.json({ok:true,result:true});
      if(u.includes('/getUpdates')){
        inflight+=1;
        if(inflight>1)console.error('[probe] {"event":"concurrent_getupdates","inflight":'+inflight+'}');
        const ok=token===valid();
        await new Promise((r)=>setTimeout(r,60));
        if(inflight>0)inflight-=1;
        if(!ok)return Response.json({ok:false,error_code:401,description:'Unauthorized'},{status:401});
        return Response.json({ok:true,result:[]});
      }
      return Response.json({ok:true,result:true});
    };
  `;
}

function startBot({ stateFile, envToken = TOKEN_A, secretValue = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-secret-'));
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  if (secretValue) writeSecretFile(secretPath, secretValue);
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fakeTelegram(stateFile))}`, 'src/main.js'], {
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
    child, ready, dir, secretPath,
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
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

async function waitFor(predicate, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`超时未满足：${label}`);
}

function setValid(stateFile, token) { writeFileSync(stateFile, token); }

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

// —— 端到端：真实子进程 + 假 Telegram API ——

test('1/2: env token bootstraps, and a secret file takes priority over env', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_B);

  // env 里放 A，文件里放 B：B 才有效 → 只有「文件优先」才能 ok。
  const bot = startBot({ stateFile, envToken: TOKEN_A, secretValue: TOKEN_B });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'file token 生效' });

  const health = await bot.health(port);
  assert.equal(health.status, 'ok');
  assert.equal(health.components.telegram_bot.state, '@reload_bot');
  assert.equal(health.runtime_secrets.telegram_bot_token.source, 'file');
  assert.equal(health.runtime_secrets.telegram_bot_token.reloadable, true);
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'loaded');
  // 元数据里没有值本身。
  assert.doesNotMatch(JSON.stringify(health.runtime_secrets), ANY_TOKEN);
});

test('3: a valid new token hot-swaps without restarting the process', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });
  const before = await bot.health(port);

  setValid(stateFile, TOKEN_B);
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_applied"'), { label: 'reload applied' });
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.last_validation === 'ok', { label: 'health 记录验证成功' });

  const after = await bot.health(port);
  assert.equal(after.status, 'ok');
  assert.equal(after.runtime_secrets.telegram_bot_token.source, 'file');
  assert.ok(after.runtime_secrets.telegram_bot_token.last_reload);
  assert.match(bot.output, /"event":"telegram_credential_swapped"/);
  assert.match(bot.output, /"event":"telegram_ingress_restarted"/);
  // 关键：进程从未重启。
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
  assert.ok(after.uptime_s >= before.uptime_s, '进程没有重启，uptime 必须继续累积');
  assert.equal(after.started_at, before.started_at);
  // 日志里没有 token。
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('4: an invalid new token is rejected and the working token is kept', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  // 误写一个无效 token：state 仍是 A，所以 B 会被 Telegram 拒绝。
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_rejected"'), { label: 'rejected' });

  const health = await bot.health(port);
  assert.equal(health.status, 'ok', 'A 仍然有效：health 必须保持 ok');
  assert.equal(health.components.telegram_auth.state, 'ok');
  assert.equal(health.runtime_secrets.telegram_bot_token.last_validation, 'invalid');
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'rejected');
  assert.match(bot.output, /"event":"secret_reload_rejected","ts":"[^"]+","name":"telegram_bot_token","reason":"invalid_token"/);
  assert.doesNotMatch(bot.output, /"event":"telegram_credential_swapped"/, '被拒绝的候选值绝不能切换');
  assert.equal(bot.child.pid, bot.pid);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

// §15：直接复现这次真实事故。
test('5/15: revoked -> degraded, then a hot-reloaded valid token recovers with the SAME pid', { timeout: 45000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  // 起点：A 已被吊销（state 指向 B，而我们用 A 启动）。
  setValid(stateFile, TOKEN_B);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;

  await waitFor(async () => (await bot.health(port)).status === 'degraded', { label: 'degraded' });
  const degraded = await bot.health(port);
  assert.equal(degraded.components.telegram_auth.state, 'unauthorized');
  assert.ok(degraded.degraded.includes('telegram_auth'));
  assert.equal(bot.child.exitCode, null, '401 不得杀死进程');
  const pidBefore = bot.child.pid;
  const startedAtBefore = degraded.started_at;

  // 不重启任何东西：只把新 token 原子写进运行时 secret。
  bot.renameSecret(TOKEN_B, 'bootstrap');
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: '热恢复为 ok' });

  const recovered = await bot.health(port);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.components.telegram_auth.state, 'ok');
  assert.equal(recovered.components.telegram_bot.state, '@reload_bot');
  assert.equal(recovered.components.telegram_ingress.state, 'polling');
  assert.match(bot.output, /"event":"telegram_auth_recovered"/);
  // 核心验收：PID 不变、进程没有重启。
  assert.equal(bot.child.pid, pidBefore);
  assert.equal(bot.child.exitCode, null);
  assert.equal(recovered.started_at, startedAtBefore, '同一进程：started_at 必须完全一致');
  assert.ok(recovered.uptime_s >= degraded.uptime_s);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('6/7: repeated rotation A->B->C->D keeps exactly one polling loop and leaks nothing', { timeout: 60000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  const chain = [TOKEN_B, TOKEN_C, TOKEN_D];
  for (const token of chain) {
    const applied = countEvents(bot.output, 'secret_reload_applied');
    setValid(stateFile, token);
    bot.writeSecret(token);
    await waitFor(async () => countEvents(bot.output, 'secret_reload_applied') > applied, { label: `切换到 ${token.slice(0, 10)}` });
  }

  await waitFor(async () => (await bot.health(port)).counters.telegram_ingress_restarts >= 4, { label: '4 次入口重建' });
  const health = await bot.health(port);
  assert.equal(health.status, 'ok');
  // 1 次启动 + 3 次轮换 = 4 个 loop，且它们严格串行。
  assert.equal(health.counters.telegram_ingress_restarts, 4, '不能多也不能少：多一个就是 loop 泄漏');
  assert.equal(countEvents(bot.output, 'concurrent_getupdates'), 0, '绝不允许两个 poll loop 同时长轮询');
  assert.equal(bot.child.pid, bot.pid);
  assert.equal(bot.child.exitCode, null);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('8: a hand-written tmp+mv rename is detected', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  // 第一次用 env 启动：文件出现后 source 必须迁移到 file。
  assert.equal((await bot.health(port)).runtime_secrets.telegram_bot_token.source, 'env');
  bot.renameSecret(TOKEN_A, 'same-value');
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.source === 'file', { label: 'source 迁移到 file' });
  assert.match(bot.output, /"event":"secret_source_migrated"/);

  setValid(stateFile, TOKEN_C);
  bot.renameSecret(TOKEN_C);
  await waitFor(async () => (await bot.health(port)).runtime_secrets.telegram_bot_token.bot_username === 'reload_bot', { label: 'rename 被识别' });
  assert.match(bot.output, /"event":"secret_reload_applied"/);
});

test('9: deleting the secret file keeps serving with the last verified token', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_B);
  const bot = startBot({ stateFile, envToken: null, secretValue: TOKEN_B });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'B 生效' });

  rmSync(bot.secretPath, { force: true });
  await waitFor(async () => bot.output.includes('"event":"secret_source_missing"'), { label: 'source missing' });

  const health = await bot.health(port);
  assert.equal(health.status, 'ok', '删文件不等于撤销：最后一次已验证的 token 继续有效');
  assert.equal(health.runtime_secrets.telegram_bot_token.state, 'stale');
  assert.equal(bot.child.exitCode, null);
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('16: reload failures never crash the process (bad file, unreadable dir, invalid content)', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

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
  assert.doesNotMatch(bot.output, ANY_TOKEN);
});

test('10: no token ever reaches health, events, stdout or stderr', { timeout: 40000 }, async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dd-state-')), 'valid');
  setValid(stateFile, TOKEN_A);
  const bot = startBot({ stateFile, envToken: TOKEN_A });
  t.after(() => { bot.child.kill('SIGKILL'); bot.cleanup(); });
  const port = await bot.ready;
  await waitFor(async () => (await bot.health(port)).status === 'ok', { label: 'A 生效' });

  setValid(stateFile, TOKEN_B);
  bot.writeSecret(TOKEN_B);
  await waitFor(async () => bot.output.includes('"event":"secret_reload_applied"'), { label: 'B applied' });
  bot.writeSecret('9999999999:ZZ' + 'z'.repeat(30));
  await waitFor(async () => countEvents(bot.output, 'secret_reload_rejected') >= 1, { label: 'invalid rejected' });

  const healthText = JSON.stringify(await bot.health(port));
  for (const text of [healthText, bot.output]) {
    assert.doesNotMatch(text, ANY_TOKEN);
    assert.doesNotMatch(text, /9{10}:ZZ/);
    assert.doesNotMatch(text, /api\.telegram\.org\/bot/);
  }
});

function countEvents(output, name) {
  return output.split(`"event":"${name}"`).length - 1;
}

// —— CLI 层：用户实际会敲的那条命令 ——

function runCli({ stateFile, secretPath, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(fakeTelegram(stateFile))}`,
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
  const stateFile = join(dir, 'valid');
  setValid(stateFile, TOKEN_D);
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  try {
    const { code, out } = await runCli({ stateFile, secretPath, input: TOKEN_D });
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
  const stateFile = join(dir, 'valid');
  setValid(stateFile, TOKEN_A);           // B 不在白名单 → getMe 会 401
  const secretPath = join(dir, 'secrets', 'telegram-bot-token');
  try {
    const rejected = await runCli({ stateFile, secretPath, input: TOKEN_B });
    assert.equal(rejected.code, 1);
    assert.equal(readSecretFile(secretPath), null, '被拒绝的 token 不得落盘');
    assert.doesNotMatch(rejected.out, ANY_TOKEN);

    // 形态不合法：连网络都不打。
    const malformed = await runCli({ stateFile, secretPath, input: 'not-a-token' });
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
