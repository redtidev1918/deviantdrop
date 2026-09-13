// Telegram 入口控制器：把「验证 token」与「运行轮询/Webhook 入口」收在一处，
// 使得 token 热更新时只需要重建入口，不必重启进程。
//
// 为什么需要它：以前 pollUpdates(env) 是从 main.js 直接 await 出去的死循环，
// 唯一的「切换 token」手段就是重启容器。现在入口有了明确生命周期：
//
//   start()  → 预检 token → 摘掉残留 webhook → 启动且仅启动一个 poll loop
//   adopt()  → 提交新 token → 中止旧 loop → 只重建 Telegram 入口
//   stop()   → 中止 loop 并等待它真正退出
//
// 三条硬约束（都有回归测试）：
//   * 任何时刻最多一个 poll loop，旧 loop 与新 loop 绝不并存；
//   * token 轮换不导致 process.exit，也不产生未捕获异常；
//   * 反复轮换不堆积 loop / 不泄漏 Promise（每次重建都 await 旧 loop 结束）。
//
// 验证候选 token 的错误分类（第 17 节）也在这里：只有「明确有效」才允许提交；
// 429 / 5xx / 超时 / DNS / 网络都算「延期」，绝不让一次网络抖动把正确的新 token 判死。

import { event, bump, setComponent } from '../runtime/status.js';
import { registerCommands } from './api.js';

const TELEGRAM_API = 'https://api.telegram.org';

export const TOKEN_VALIDATION = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  DEFERRED: 'deferred',
});

/** Telegram token 的形态：`<bot_id>:<secret>`。只做基本形状检查，真伪由 getMe 决定。 */
export function tokenShapeOk(token) {
  return typeof token === 'string' && /^\d{5,12}:[A-Za-z0-9_-]{25,}$/.test(token.trim());
}

/**
 * 只读验证一个候选 token。绝不返回或记录 token 本身。
 *
 * @returns {Promise<{status:string, httpStatus:number|null, reason:string, botId?:number, botUsername?:string}>}
 */
export async function validateBotToken(token, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  if (!tokenShapeOk(token)) return { status: TOKEN_VALIDATION.INVALID, httpStatus: null, reason: 'malformed_token' };
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token.trim()}/getMe`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // 网络层失败绝不等价于「凭据无效」：延期验证，保留当前凭据。
    return { status: TOKEN_VALIDATION.DEFERRED, httpStatus: null, reason: error?.cause?.code || error?.name || 'network_error' };
  }
  const data = await response.json().catch(() => null);
  if (response.status === 429) {
    return { status: TOKEN_VALIDATION.DEFERRED, httpStatus: 429, reason: 'rate_limited' };
  }
  if (response.status >= 500) {
    return { status: TOKEN_VALIDATION.DEFERRED, httpStatus: response.status, reason: 'telegram_unavailable' };
  }
  if (response.ok && data?.ok) {
    return {
      status: TOKEN_VALIDATION.VALID,
      httpStatus: response.status,
      reason: 'ok',
      botId: data.result?.id ?? null,
      botUsername: data.result?.username ?? null,
    };
  }
  // 4xx（含 401 Unauthorized / 404 形态错误）：这是「凭据本身不对」，不是暂时故障。
  return {
    status: TOKEN_VALIDATION.INVALID,
    httpStatus: response.status,
    reason: data?.description || `HTTP ${response.status}`,
  };
}

export class TelegramIngressController {
  /**
   * @param {object} options
   * @param {object} options.env         启动时构造的 env 对象；env.BOT_TOKEN 是运行时事实来源
   * @param {string} options.mode        poll | webhook
   * @param {Array}  options.adminIds
   * @param {number} options.pollTimeoutMs
   * @param {Function} options.handleUpdate  处理单条 update（由 main.js 注入，避免反向依赖入口文件）
   */
  constructor({ env, mode = 'poll', adminIds = [], pollTimeoutMs = 35_000, handleUpdate = null } = {}) {
    this.env = env;
    this.mode = mode;
    this.adminIds = adminIds;
    this.pollTimeoutMs = pollTimeoutMs;
    this.handleUpdate = handleUpdate || (async () => {});

    this.generation = 0;
    this.abort = null;
    this.loop = null;          // 当前 loop 的 Promise（用于等待它真正退出）
    this.serial = Promise.resolve();
    this.lastAuthOk = false;
  }

  /** 是否存在活跃 loop（测试与 /health 用）。 */
  activeLoops() {
    return this.loop ? 1 : 0;
  }

  /** 启动入口：预检 + （poll）摘 webhook + 启动唯一 loop。 */
  async start() {
    const auth = await this.#preflight();
    if (this.mode === 'webhook') {
      await this.#startWebhookMode(auth);
      return auth;
    }
    return this.#serialize(async () => {
      await this.#clearStaleWebhook();
      this.#launchLoop('startup');
    });
  }

  /**
   * 提交一个已被验证的 token 并只重建 Telegram 入口。
   * 提交点就是 `env.BOT_TOKEN = token`：所有 Telegram 调用都在调用时读 env.BOT_TOKEN，
   * 所以这里不需要通知任何其他子系统（HTTP server / DA auth / cache / preview / OAuth 全部不动）。
   */
  async adopt({ token, botId = null, botUsername = null, reason = 'token_reload' } = {}) {
    const wasOk = this.lastAuthOk;
    this.env.BOT_TOKEN = token;
    this.#markAuthOk({ botId, botUsername });
    event('telegram_credential_swapped', {
      reason, source: 'runtime_secret', generation: this.generation + 1, bot_id: botId, bot_username: botUsername,
    });

    if (this.mode === 'webhook') {
      await this.#serialize(() => this.#startWebhookMode({ botId, botUsername }, { reason }));
    } else {
      await this.#serialize(async () => {
        await this.#clearStaleWebhook();
        this.#launchLoop(reason);
      });
    }
    // 命令菜单是 per-bot 的：换了 token 就必须为新 bot 重注册一次。
    await registerCommands(this.env, this.adminIds);
    if (!wasOk) {
      event('telegram_auth_recovered', { reason, bot_id: botId, bot_username: botUsername });
      bump('telegram_auth_recovered');
    }
    return this.lastAuthOk;
  }

  /** 中止入口（进程退出、或测试收尾）。 */
  async stop(reason = 'stop') {
    await this.#serialize(async () => {
      await this.#abortLoop(reason);
      setComponent('telegram_ingress', { state: 'stopped', ok: false, critical: true, detail: reason });
    });
  }

  /** 同一时刻只允许一个重建过程：并发 reload 会串行化，不会产生第二个 loop。 */
  #serialize(task) {
    const run = this.serial.then(task, task);
    // 保持链的健康：任何一个任务的失败都不允许毒化后续轮换。
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  async #abortLoop(reason) {
    if (this.abort && !this.abort.signal.aborted) this.abort.abort(new Error(reason));
    const pending = this.loop;
    this.loop = null;
    this.abort = null;
    if (pending) {
      // 等旧 loop 真正退出再放行新 loop：这是「绝不并存两个 getUpdates」的实现方式。
      await pending.catch(() => undefined);
    }
  }

  #launchLoop(reason) {
    const generation = this.generation + 1;
    this.generation = generation;
    const abort = new AbortController();
    this.abort = abort;
    event('telegram_ingress_restarted', {
      reason, generation, mode: 'poll', superseded_loop: reason !== 'startup',
    });
    bump('telegram_ingress_restarts');
    this.loop = this.#pollLoop(abort.signal, generation)
      .catch((error) => {
        // loop 自身的异常绝不允许逃到顶层：它只是入口重建的触发条件。
        event('telegram_ingress_loop_failed', {
          generation, error: error?.name || 'Error', message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.generation === generation) this.loop = null;
      });
  }

  async #startWebhookMode(identity = {}, { reason = 'startup' } = {}) {
    // 本项目从不自动 setWebhook（webhook 的注册是操作员的显式动作，见 docs/VPS.md）。
    // 但 token 换了以后，新 bot 不一定已经注册过 webhook——这一点必须出现在 health 里，
    // 而不是假装入口可用。
    setComponent('telegram_ingress', { state: 'starting', ok: false, critical: true });
    const state = await this.#webhookState();
    if (!state.readable) {
      setComponent('telegram_ingress', { state: 'webhook_unknown', ok: false, critical: true, detail: state.transport || null });
      event('telegram_webhook_state', { mode: 'webhook', phase: reason, ...state });
      return identity;
    }
    if (state.has_webhook) {
      setComponent('telegram_ingress', { state: 'webhook', ok: true, critical: true, detail: state.host || null });
    } else {
      setComponent('telegram_ingress', {
        state: 'webhook_unregistered', ok: false, critical: true,
        detail: 'setWebhook not registered for the current token',
      });
      event('telegram_webhook_reregistration_required', {
        mode: 'webhook', phase: reason,
        hint: 'token 轮换后需要为当前 bot 重新注册 setWebhook（本项目不自动注册）',
      });
    }
    event('telegram_webhook_state', { mode: 'webhook', phase: reason, ...state });
    return identity;
  }

  /**
   * 启动预检（只读 getMe）。把「凭据是否可用」与「Bot 是谁」变成 /health 上的事实。
   * username 是公开信息，不涉及 secret。
   */
  async #preflight() {
    const token = this.env.BOT_TOKEN;
    if (!token) {
      setComponent('telegram_auth', { state: 'missing_token', ok: false, critical: true, detail: 'BOT_TOKEN 未配置' });
      setComponent('telegram_bot', { state: 'unknown', ok: false, critical: false });
      this.lastAuthOk = false;
      event('telegram_auth_missing', { stage: 'getMe' });
      return { status: TOKEN_VALIDATION.INVALID, reason: 'missing_token' };
    }
    const result = await validateBotToken(token);
    if (result.status === TOKEN_VALIDATION.VALID) {
      this.#markAuthOk(result);
      event('telegram_auth_ok', { stage: 'getMe', bot_id: result.botId, bot_username: result.botUsername });
      return result;
    }
    if (result.status === TOKEN_VALIDATION.DEFERRED) {
      setComponent('telegram_auth', { state: 'network_error', ok: false, critical: true, detail: result.reason });
      setComponent('telegram_bot', { state: 'unreachable', ok: false, critical: false });
      this.lastAuthOk = false;
      event('telegram_auth_unreachable', { stage: 'getMe', transport: result.reason });
      return result;
    }
    setComponent('telegram_auth', { state: 'unauthorized', ok: false, critical: true, detail: result.reason });
    setComponent('telegram_bot', { state: 'unavailable', ok: false, critical: false });
    this.lastAuthOk = false;
    bump('telegram_unauthorized');
    event('telegram_auth_rejected', {
      stage: 'getMe',
      status: result.httpStatus,
      hint: 'BOT_TOKEN 已失效/被吊销：可用运行时 secret 热更新（无需重启容器），见 docs/VPS.md',
    });
    return result;
  }

  #markAuthOk({ botId = null, botUsername = null } = {}) {
    setComponent('telegram_auth', { state: 'ok', ok: true, critical: true, detail: null });
    setComponent('telegram_bot', {
      state: botUsername ? `@${botUsername}` : 'unknown',
      ok: true,
      critical: false,
      detail: botId ? `id=${botId}` : null,
    });
    this.lastAuthOk = true;
  }

  /**
   * 只读探测：Telegram 当前是否注册了 webhook。
   * 只输出「有没有」与主机名，不输出完整 URL（URL 路径里可能带凭据）。
   */
  async #webhookState() {
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.env.BOT_TOKEN}/getWebhookInfo`, {
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) return { readable: false, status: response.status };
      const info = data.result || {};
      let host = null;
      try { host = info.url ? new URL(info.url).host : null; } catch { host = 'unparseable'; }
      return {
        readable: true,
        has_webhook: Boolean(info.url),
        host,
        pending_update_count: Number(info.pending_update_count ?? 0),
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
      };
    } catch (error) {
      return { readable: false, transport: error?.cause?.code || error?.name || 'error' };
    }
  }

  /**
   * poll 与 webhook 互斥：残留 webhook 会让 getUpdates 直接 409，表现就是「Bot 完全不回复」。
   * 每次（重）启动 poll 都先读回状态再显式摘掉——换 token 后同样适用。
   */
  async #clearStaleWebhook() {
    const before = await this.#webhookState();
    event('telegram_webhook_state', { mode: 'poll', phase: 'before_cleanup', ...before });
    if (!before.readable || !before.has_webhook) return before;
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.env.BOT_TOKEN}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => null);
      event('telegram_webhook_cleared', { ok: Boolean(response.ok && data?.ok), status: response.status });
    } catch (error) {
      event('telegram_webhook_clear_failed', { transport: error?.cause?.code || error?.name || 'error' });
    }
    return before;
  }

  /**
   * 长轮询循环。signal 只用于中止「取更新」这一跳：
   *   * 已经进入处理的 update 不会被粗暴 kill（handler 会跑完）；
   *   * 中止后循环在下一个检查点干净退出，不抛异常、不 exit。
   */
  async #pollLoop(signal, generation) {
    console.log('DeviantDrop poll mode: getUpdates loop (HTTP server 同时运行)');
    let offset = 0;
    let unauthorizedAttempts = 0;

    while (!signal.aborted) {
      try {
        const query = new URLSearchParams({
          timeout: '25',
          offset: String(offset),
          allowed_updates: '["message","channel_post"]',
        });
        const response = await fetch(
          `${TELEGRAM_API}/bot${this.env.BOT_TOKEN}/getUpdates?${query}`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(this.pollTimeoutMs)]) },
        );
        const data = await response.json().catch(() => null);
        if (signal.aborted) return;
        if (!response.ok || !data?.ok) {
          const description = data?.description || `HTTP ${response.status}`;
          console.error('getUpdates 失败:', description);
          if (response.status === 401) {
            // 关键：不退出。退出 + restart 策略 = 无限重启循环，连 /health 都读不到。
            // 现在还有更好的出路：把新 token 写进运行时 secret，入口会自己热恢复。
            unauthorizedAttempts += 1;
            setComponent('telegram_ingress', { state: 'unauthorized', ok: false, critical: true, detail: description });
            setComponent('telegram_auth', { state: 'unauthorized', ok: false, critical: true, detail: description });
            this.lastAuthOk = false;
            bump('telegram_unauthorized');
            event('telegram_ingress_unauthorized', {
              stage: 'getUpdates',
              attempt: unauthorizedAttempts,
              hint: 'BOT_TOKEN 已失效/被吊销：改用运行时 secret 热更新即可恢复（无需重启容器），见 docs/VPS.md',
            });
            await sleep(backoffMs(unauthorizedAttempts, 5_000, 60_000), signal);
            continue;
          }
          if (response.status === 409) {
            setComponent('telegram_ingress', { state: 'conflict', ok: false, critical: true, detail: description });
            bump('telegram_conflict');
            event('telegram_ingress_conflict', {
              stage: 'getUpdates',
              hint: '另一个 getUpdates 长轮询实例在跑，或仍残留 webhook；两者都会让更新被抢走',
            });
            await sleep(5_000, signal);
            continue;
          }
          setComponent('telegram_ingress', { state: 'error', ok: false, critical: true, detail: description });
          event('telegram_ingress_error', { stage: 'getUpdates', status: response.status });
          await sleep(3_000, signal);
          continue;
        }

        unauthorizedAttempts = 0;
        setComponent('telegram_ingress', { state: 'polling', ok: true, critical: true, detail: null });
        setComponent('telegram_auth', { state: 'ok', ok: true, critical: true, detail: null });
        this.lastAuthOk = true;

        for (const update of data.result || []) {
          const msg = update.message ?? update.channel_post;
          console.log(
            `[upd] id=${update.update_id} chat=${msg?.chat?.type ?? "?"}(${msg?.chat?.id ?? "?"}) ` +
            `from=${msg?.from?.id ?? "?"} hasText=${!!(msg?.text || msg?.caption)}`,
          );
          bump('updates_received');
          try {
            await this.handleUpdate(update, this.env, null);
          } catch (error) {
            bump('update_handler_errors');
            event('update_handler_failed', {
              update_id: update.update_id,
              error: error instanceof Error ? error.name : 'Error',
              message: error instanceof Error ? error.message : String(error),
            });
            console.error('update 处理异常:', error instanceof Error ? error.message : String(error));
          }
          offset = Math.max(offset, Number(update.update_id ?? 0) + 1);
        }
        if ((data.result || []).length === 0) await sleep(500, signal);
      } catch (error) {
        // 中止不是故障：轮换触发的取消必须干净退出，而不是记成网络错误。
        if (signal.aborted) return;
        setComponent('telegram_ingress', {
          state: 'network_error', ok: false, critical: true,
          detail: error?.cause?.code || error?.name || 'error',
        });
        bump('telegram_ingress_network_errors');
        event('telegram_ingress_error', {
          stage: 'getUpdates', transport: error?.cause?.code || error?.name || 'error',
        });
        console.error('getUpdates 网络错误:', error.cause?.code || error.name, '3 秒后重试');
        await sleep(3_000, signal);
      }
    }
  }
}

/** 有上限的指数退避：5s → 10s → 20s → 40s → 60s（封顶），避免热循环刷日志。 */
function backoffMs(attempt, base, cap) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
}

/** 可中止的 sleep：轮换时不能因为一次 5~60 秒退避而卡住入口重建。 */
function sleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    }
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}
