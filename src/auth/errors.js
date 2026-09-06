// DeviantDrop 的错误类型归一化。上层 UI（caption / 用户提示 / 管理员通知）
// 不再依赖零散字符串匹配，而是按错误类别决定提示与重试行为。
//
// 普通用户只看到简洁中文；日志里可记录 class/stage/status，但绝不包含
// token / cookie / secret。

export class DeviantDropError extends Error {
  constructor(message, { stage = null, status = null, publicMessage = null } = {}) {
    super(message);
    this.name = "DeviantDropError";
    this.stage = stage;
    this.status = status;
    // 用户可见文案；未设则用 message（保持向后兼容）。
    this.publicMessage = publicMessage || message;
  }
}

// 认证类（OAuth / 登录态）问题：成熟内容可能只能拿公开预览。
export class AuthError extends DeviantDropError {
  constructor(message, opts = {}) {
    super(message, { publicMessage: "DeviantArt 登录状态异常，本次可能只能获得公开预览。", ...opts });
    this.name = "AuthError";
  }
}
// refresh token 已失效/被吊销：必须重新走 /login，不能再拿旧 token 反复尝试。
export class AuthRevokedError extends AuthError {
  constructor(message = "DeviantArt 登录已失效，需要重新授权。", opts = {}) {
    super(message, { publicMessage: "DeviantArt 登录状态已失效，本次可能只能获得公开预览。", ...opts });
    this.name = "AuthRevokedError";
    this.revoked = true;
  }
}
// Cookie 过期/无效。
export class CookieExpiredError extends AuthError {
  constructor(message = "DeviantArt 登录 Cookie 已过期。", opts = {}) {
    super(message, opts);
    this.name = "CookieExpiredError";
  }
}
// 权限不足（内容需要更高权限/被屏蔽）。
export class PermissionDeniedError extends DeviantDropError {
  constructor(message = "无权访问该作品。", opts = {}) {
    super(message, { publicMessage: "这个作品无权访问（可能需要登录或被作者限制）。", ...opts });
    this.name = "PermissionDeniedError";
  }
}
// 限流。
export class RateLimitError extends DeviantDropError {
  constructor(message = "DeviantArt 限流，请稍后再试。", opts = {}) {
    super(message, { publicMessage: "DeviantArt 暂时限流，请稍后再试。", ...opts });
    this.name = "RateLimitError";
  }
}
// 免费账号原图日配额（403/429「Free download limit reached」）。
export class QuotaError extends DeviantDropError {
  constructor(message = "原图下载额度受限。", opts = {}) {
    super(message, { publicMessage: "原图下载额度受限，已改用最高清展示图。", ...opts });
    this.name = "QuotaError";
  }
}
// 网络/超时（这类才值得在 web/official 通道间切换重试）。
export class NetworkError extends DeviantDropError {
  constructor(message = "网络连接失败，请稍后重试。", opts = {}) {
    super(message, { publicMessage: "网络连接失败或超时，请稍后再试。", ...opts });
    this.name = "NetworkError";
  }
}
// 作品不存在 / 无法解析。
export class NotFoundError extends DeviantDropError {
  constructor(message = "没有找到这个作品。", opts = {}) {
    super(message, { publicMessage: "没有找到这个 DeviantArt 作品（链接可能有误或已删除）。", ...opts });
    this.name = "NotFoundError";
  }
}

// 把任意错误归一成用户可见的文案：分类错误用中文提示；其余剥离疑似 secret 后
// 保留可读原文（便于用户反馈定位），绝不泄漏 token / cookie / bot token。
export function publicError(error) {
  if (error instanceof DeviantDropError) return error.publicMessage || error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/file is too big/i.test(message)) return "媒体超过 Telegram Bot 的文件大小限制";
  if (/failed to get http url content|wrong type of the web page content/i.test(message)) {
    return "Telegram 无法读取该媒体，作品可能受限或媒体格式不受支持";
  }
  if (/timeout|timed out|abort/i.test(message)) return "请求超时，请稍后重试";
  const cleaned = message
    .replace(/(token|cookie|secret|pass|key)\s*[=:]\s*[^\s"'`]+/gi, "$1=<redacted>")
    .replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, "bot_token=<redacted>")
    .trim()
    .slice(0, 300);
  return cleaned || "服务暂时无法完成该请求，请稍后重试。";
}

export function failureText(error) {
  const category = error instanceof AuthError ? "登录提示" : error instanceof PermissionDeniedError ? "访问受限" : error instanceof NotFoundError ? "未找到作品" : error instanceof RateLimitError ? "请求限流" : error instanceof NetworkError ? "连接失败" : "处理失败";
  return `${category}：${publicError(error)}`;
}
