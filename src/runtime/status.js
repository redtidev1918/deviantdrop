// 运行时状态登记表 + 结构化事件日志。
//
// 目的：让「一条日志区分故障域」成为可能。以前容器反复重启 1000+ 次、/health 仍返回
// {ok:true}，无法判断是 Telegram 入口、DeviantArt 抓取、媒体处理还是 Telegram 出口坏了。
//
// 约定：
//   * 每个生命周期事件一行 JSON，前缀 [evt]，可直接 docker logs | grep '\[evt\]'；
//   * 事件名固定，覆盖 update_received → update_accepted/rejected → da_fetch_* → tg_send_*；
//   * 任何字段在写出前经过 redact()，token / cookie / secret 一律不会进入日志（纵深防御，
//     调用方本来也不应该传 secret）。
//
// 依赖：仅 node:util 与 console，无第三方依赖，Cloudflare Worker 与 Node 两侧都能用。

const SECRET_KEY = /token|secret|cookie|password|passwd|api_?key|authorization|refresh|client_?secret|signature|hmac|credential/i;

// 明文凭据形态：Telegram bot token、JWT、Bearer。
const SECRET_VALUE = [
  // 不能加前置 \b：Telegram URL 里 token 紧跟在 "bot" 后面（`.../bot123:ABC.../getUpdates`），
  // 两侧都是词字符，\b 永远不成立，于是 token 会原样进日志。
  /\d{5,12}:[A-Za-z0-9_-]{25,}/g,
  /eyJ[A-Za-z0-9._-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_STRING = 512;
const RECENT_EVENT_LIMIT = 40;

function redactString(value) {
  let out = String(value).slice(0, MAX_STRING);
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, REDACTED);
  return out;
}

/** Recursively strip secret-shaped keys and values. Exported for tests. */
export function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return redactString(value);
}

const startedAt = Date.now();
const components = new Map();
const counters = new Map();
const recent = [];

function nowIso() {
  return new Date().toISOString();
}

/**
 * Register/update a component's health.
 * `critical` components decide the overall status: a failing critical component
 * means the service is degraded (e.g. Telegram ingress unauthorized), while a
 * non-critical one (DeviantArt auth) must never make the bot look "down".
 */
export function setComponent(name, { state, ok, detail = null, critical = false } = {}) {
  const previous = components.get(name);
  components.set(name, {
    state: state ?? previous?.state ?? "unknown",
    ok: ok ?? previous?.ok ?? false,
    detail: detail === null ? null : redactString(detail),
    critical: critical ?? previous?.critical ?? false,
    updated_at: nowIso(),
  });
}

export function bump(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

/** One structured lifecycle line. Never pass a secret; redact() is the backstop. */
export function event(name, fields = undefined) {
  const entry = { event: name, ts: nowIso(), ...(fields ? redact(fields) : {}) };
  recent.push(entry);
  if (recent.length > RECENT_EVENT_LIMIT) recent.splice(0, recent.length - RECENT_EVENT_LIMIT);
  console.error(nowIso(), "[evt]", JSON.stringify(entry));
  return entry;
}

export function snapshot() {
  const componentObject = {};
  let degraded = [];
  for (const [name, value] of components) {
    componentObject[name] = value;
    if (value.critical && !value.ok) degraded.push(name);
  }
  return {
    components: componentObject,
    counters: Object.fromEntries(counters),
    degraded,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    recent_events: recent.slice(-RECENT_EVENT_LIMIT),
  };
}

/**
 * /health payload. Liveness stays 200 (so Docker never restarts on a degraded
 * dependency), but `ok`/`status` describe real capability.
 */
export function healthPayload({ service = "deviantdrop", version = null, mode = null } = {}) {
  const snap = snapshot();
  const ok = snap.degraded.length === 0 && components.get("telegram_ingress")?.state !== "starting";
  return {
    ok,
    status: ok ? "ok" : "degraded",
    service,
    version,
    mode,
    uptime_s: snap.uptime_s,
    started_at: new Date(startedAt).toISOString(),
    degraded: snap.degraded,
    components: snap.components,
    counters: snap.counters,
    recent_events: snap.recent_events,
  };
}

/** Test seam: reset all state between cases. */
export function resetForTest() {
  components.clear();
  counters.clear();
  recent.length = 0;
}
