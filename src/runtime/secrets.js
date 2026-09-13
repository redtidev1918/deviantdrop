// 运行时 secret 存储：把「换 Telegram token」从「改 .env + 重建容器」变成运行时操作。
//
// 事故背景（2026-09-12）：BotFather 吊销了 bot token，容器因此进入无限重启；崩溃循环
// 修好之后，恢复手段仍然只有 `docker compose up -d --force-recreate`——因为 token 直接
// 来自 process.env，而运行中的容器环境变量是只读的。
//
// 本模块的契约（每一条都有对应的回归测试）：
//
//   1. 优先级 file > env。文件是运行时事实来源，env 只是 bootstrap / fallback；
//   2. 绝不监听 .env。.env 是部署层输入，不是运行时数据库，容器环境变量也无法热改；
//   3. 发现候选值后必须「先验证、再提交」——验证由订阅者完成（对 Telegram 就是 getMe）；
//   4. 验证未成功（无效 / 429 / 5xx / 超时）时绝不替换当前值；
//   5. 文件被删除时保留最后一次已验证的值，只把 source 标成 stale；
//   6. 任何 IO / 解析 / 权限错误都是可恢复事件，绝不抛到轮询循环之外（更不允许导致进程退出）；
//   7. 支持原子 rename（临时文件 + mv）：靠 stat 戳（ino/mtime/size）识别，而不是假设原地修改。
//
// 依赖：仅 node:fs / node:path / node:crypto，不引入任何第三方依赖，也不进入 Worker 包。

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { event, bump, setRuntimeSecret } from './status.js';

/** 默认路径：/data 已经是持久卷，不再新增第二个 volume。 */
export const DEFAULT_SECRET_DIR = '/data/secrets';
export const DEFAULT_TELEGRAM_TOKEN_PATH = `${DEFAULT_SECRET_DIR}/telegram-bot-token`;

export const SECRET_SOURCE = Object.freeze({ FILE: 'file', ENV: 'env', MISSING: 'missing' });
export const SECRET_STATE = Object.freeze({
  LOADED: 'loaded',
  VALIDATING: 'validating',
  REJECTED: 'rejected',
  STALE: 'stale',
  MISSING: 'missing',
});

/** 目录 0700 / 文件 0600：只有容器内的运行用户能读写。 */
export const SECRET_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

/**
 * 原子写一个 secret 文件：临时文件（0600）→ fsync → rename。
 * 用户手动 `mktemp` + `mv` 是同一种语义，本函数只是把它内置给 CLI 用。
 */
export function writeSecretFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: SECRET_DIR_MODE });
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', SECRET_FILE_MODE);
    writeFileSync(fd, String(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
  return path;
}

/** 读取一个 secret 文件；不存在/为空/不可读都返回 null（由调用方决定语义）。 */
export function readSecretFile(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function statStamp(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    // ino 变化 = 原子 rename（新文件），mtime/size 变化 = 原地重写。两者都要能识别。
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function errorCode(error) {
  return error?.code || error?.name || 'error';
}

/**
 * 单个 secret 的运行时来源。一个实例管一个名字（当前只有 telegram.bot_token）。
 *
 * @param {object} options
 * @param {string} options.name            /health 里 runtime_secrets 的键，例如 telegram_bot_token
 * @param {string} options.path            secret 文件路径
 * @param {string|null} options.envValue   仅作 bootstrap / fallback 的环境变量值
 * @param {string|null} options.envVar     环境变量名（只用于可观测性，不读它）
 * @param {number} options.pollIntervalMs  stat 轮询间隔（默认 1500ms：rename 也不会漏）
 */
export class RuntimeSecretStore {
  constructor({ name, path, envValue = null, envVar = null, pollIntervalMs = 1500 } = {}) {
    if (!name) throw new Error('RuntimeSecretStore requires a name');
    if (!path) throw new Error('RuntimeSecretStore requires a path');
    this.name = name;
    this.path = path;
    this.envVar = envVar;
    this.pollIntervalMs = pollIntervalMs;

    this.value = null;
    this.source = SECRET_SOURCE.MISSING;
    this.state = SECRET_STATE.MISSING;
    this.lastReload = null;
    this.lastValidation = null;
    this.lastReason = null;
    this.botId = null;
    this.botUsername = null;

    this.subscribers = [];
    this.timer = null;
    this.checking = false;
    this.stamp = null;
    this.emptyStamp = null;
    this.deferAttempts = 0;
    this.nextRetryAt = 0;
    this.missingReported = false;

    // 启动解析：文件优先，env 兜底。env 只有在此刻被读一次，之后不再是事实来源。
    const fromFile = readSecretFile(path);
    if (fromFile) {
      this.value = fromFile;
      this.source = SECRET_SOURCE.FILE;
      this.state = SECRET_STATE.LOADED;
      this.stamp = statStamp(path);
    } else if (envValue) {
      this.value = String(envValue).trim();
      this.source = SECRET_SOURCE.ENV;
      this.state = SECRET_STATE.LOADED;
    }
    this.publish();
  }

  /** 订阅者：拿到候选值，验证后返回 { ok, defer?, reason?, detail? }。 */
  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((entry) => entry !== callback);
    };
  }

  /** 建立目录（0700）以便操作员投放 secret 文件；不写入任何内容。 */
  ensureDir() {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: SECRET_DIR_MODE });
      return true;
    } catch (error) {
      event('secret_dir_unavailable', { name: this.name, error: errorCode(error) });
      return false;
    }
  }

  /** /health 用的摘要。只有元数据，没有值。 */
  status() {
    return {
      source: this.source,
      reloadable: true,
      state: this.state,
      last_reload: this.lastReload,
      last_validation: this.lastValidation,
      last_reason: this.lastReason,
      bot_id: this.botId,
      bot_username: this.botUsername,
    };
  }

  publish(extra = {}) {
    const entry = setRuntimeSecret(this.name, { ...this.status(), ...extra });
    return entry;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { void this.check(); }, this.pollIntervalMs);
    // 这个定时器不允许自己把进程留在前台：进程的存活由 HTTP server / poll loop 决定。
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /**
   * 一次轮询：识别文件变化 → 交订阅者验证 → 提交或拒绝。
   * 永不抛出：所有失败都变成事件 + 计数器。
   */
  async check() {
    if (this.checking) return { changed: false, reason: 'in_flight' };
    if (Date.now() < this.nextRetryAt) return { changed: false, reason: 'deferred_backoff' };
    this.checking = true;
    try {
      return await this.#pollOnce();
    } catch (error) {
      // 兜底：任何未预期错误都不得逃出轮询（崩溃循环就是从这个级别的疏漏开始的）。
      event('secret_reload_error', { name: this.name, error: errorCode(error) });
      bump('secret_reload_errors');
      return { changed: false, reason: 'error' };
    } finally {
      this.checking = false;
    }
  }

  async #pollOnce() {
    const stamp = statStamp(this.path);

    if (stamp === null) {
      // 文件不见了：保留最后一次已验证的值，只标记来源过期。
      if (this.source === SECRET_SOURCE.FILE && !this.missingReported) {
        this.missingReported = true;
        this.state = SECRET_STATE.STALE;
        event('secret_source_missing', {
          name: this.name,
          kept: 'last_verified_value',
          hint: '运行时 secret 文件被删除；继续使用最后一次已验证的值，如需撤销请显式轮换',
        });
        this.publish();
      }
      return { changed: false, reason: 'missing' };
    }

    if (stamp === this.stamp) return { changed: false, reason: 'unchanged' };

    let candidate;
    try {
      candidate = readFileSync(this.path, 'utf8').trim();
    } catch (error) {
      event('secret_reload_unreadable', { name: this.name, error: errorCode(error) });
      bump('secret_reload_errors');
      return { changed: false, reason: 'unreadable' };
    }

    if (!candidate) {
      // 临时空文件（原地截断的中间态）：绝不据此清空一个有效的运行时凭据。
      if (this.emptyStamp !== stamp) {
        this.emptyStamp = stamp;
        event('secret_reload_ignored', { name: this.name, reason: 'empty_candidate' });
      }
      return { changed: false, reason: 'empty' };
    }

    if (candidate === this.value) {
      // 内容等价：不需要重新验证。但如果此前来源是 env，说明操作员刚刚把同一个值
      // 落到了文件上——此刻起文件才是事实来源（也是「env 用户第一次 token set 就迁移」
      // 的那条路径），不需要再打一次 getMe。
      const migrated = this.source !== SECRET_SOURCE.FILE;
      this.stamp = stamp;
      this.missingReported = false;
      if (migrated) {
        this.source = SECRET_SOURCE.FILE;
        this.state = SECRET_STATE.LOADED;
        event('secret_source_migrated', { name: this.name, from: SECRET_SOURCE.ENV, to: SECRET_SOURCE.FILE });
        this.publish();
        return { changed: true, applied: false, reason: 'source_migrated' };
      }
      return { changed: false, reason: 'same_value' };
    }

    event('secret_reload_detected', { name: this.name, source: SECRET_SOURCE.FILE, bytes: candidate.length });
    bump('secret_reload_detected');
    this.state = SECRET_STATE.VALIDATING;
    this.publish();

    const outcome = await this.#accept(candidate);

    if (outcome.applied) {
      this.value = candidate;
      this.source = SECRET_SOURCE.FILE;
      this.state = SECRET_STATE.LOADED;
      this.lastReload = new Date().toISOString();
      this.lastValidation = 'ok';
      this.lastReason = null;
      this.stamp = stamp;
      this.emptyStamp = null;
      this.missingReported = false;
      this.deferAttempts = 0;
      if (outcome.botId != null) this.botId = outcome.botId;
      if (outcome.botUsername != null) this.botUsername = outcome.botUsername;
      event('secret_reload_applied', {
        name: this.name, source: SECRET_SOURCE.FILE,
        bot_id: this.botId, bot_username: this.botUsername, elapsed_ms: outcome.elapsedMs ?? null,
      });
      bump('secret_reload_applied');
      this.publish();
      return { changed: true, applied: true, reason: 'applied' };
    }

    if (outcome.defer) {
      // 429 / 5xx / 超时 / DNS：不提交、也不作废候选——退避后重试同一个候选值，
      // 避免「网络抖一下就把一个本来正确的新 token 判死」。
      this.deferAttempts += 1;
      this.nextRetryAt = Date.now() + Math.min(10_000 * 2 ** (this.deferAttempts - 1), 60_000);
      this.state = this.value ? SECRET_STATE.LOADED : SECRET_STATE.MISSING;
      this.lastValidation = 'deferred';
      this.lastReason = outcome.reason || 'validation_deferred';
      event('secret_reload_deferred', {
        name: this.name, reason: this.lastReason, attempt: this.deferAttempts,
        retry_in_ms: Math.max(0, this.nextRetryAt - Date.now()),
      });
      bump('secret_reload_deferred');
      this.publish();
      return { changed: false, applied: false, defer: true, reason: this.lastReason };
    }

    this.state = SECRET_STATE.REJECTED;
    this.lastValidation = 'invalid';
    this.lastReason = outcome.reason || 'invalid_token';
    // 关键：把 stamp 记下来，避免对同一个被拒绝的内容反复打 getMe；
    // 但如果操作员真的改了文件（stamp 变化），会立刻重新验证。
    this.stamp = stamp;
    event('secret_reload_rejected', {
      name: this.name, reason: this.lastReason,
      kept: this.value ? 'current_runtime_value' : 'none',
    });
    bump('secret_reload_rejected');
    this.publish();
    return { changed: false, applied: false, reason: this.lastReason };
  }

  /** 依次问订阅者；只有明确 ok 才算成功。 */
  async #accept(candidate) {
    const startedAt = Date.now();
    if (this.subscribers.length === 0) return { applied: false, reason: 'no_subscriber' };
    let meta = {};
    for (const subscriber of this.subscribers) {
      let result;
      try {
        result = await subscriber(candidate, { name: this.name, path: this.path, source: SECRET_SOURCE.FILE });
      } catch (error) {
        event('secret_reload_subscriber_error', { name: this.name, error: errorCode(error) });
        return { applied: false, reason: 'subscriber_error' };
      }
      if (!result) return { applied: false, reason: 'no_subscriber_decision' };
      if (result.defer) return { applied: false, defer: true, reason: result.reason || 'validation_deferred' };
      if (!result.ok) return { applied: false, reason: result.reason || 'rejected' };
      meta = result;
    }
    return {
      applied: true,
      botId: meta.botId ?? null,
      botUsername: meta.botUsername ?? null,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
