// 认证失效/恢复的管理员通知，带去重（cooldown），避免每个作品都轰炸管理员。
//
//   - invalid：同一持续失效 6 小时内只通知一次；期间用户请求仍正常 fallback。
//   - recovered：重新登录成功后通知一次，并清掉 cooldown。
// 普通用户只看到简洁 fallback 提示；管理员收到带「重新登录」按钮的详情（不含 secret）。
// 通知本身失败不影响作品发送。

const COOLDOWN_SECONDS = 6 * 3600;

export class AuthNotifier {
  constructor({ cacheGet, cacheSet, sendTelegram, adminIds = [], loginUrl = null, loginUrlBuilder = null } = {}) {
    this.cacheGet = cacheGet || (async () => null);
    this.cacheSet = cacheSet || (async () => {});
    this.sendTelegram = sendTelegram;
    this.adminIds = adminIds;
    // loginUrl：静态链接；loginUrlBuilder()：动态生成（可签发一次性 token）。后者优先。
    this.loginUrl = loginUrl;
    this.loginUrlBuilder = loginUrlBuilder;
  }

  async buildLoginUrl(kind) {
    try {
      if (this.loginUrlBuilder) return (await this.loginUrlBuilder(kind)) || this.loginUrl;
    } catch { /* 落回静态链接 */ }
    return this.loginUrl;
  }

  async notifyInvalid(reason = "refresh token invalid", kind = "oauth") {
    if (this.notifying) return this.notifying;
    this.notifying = this.sendInvalid(reason, kind);
    try { await this.notifying; } finally { this.notifying = null; }
  }

  async sendInvalid(reason, kind) {
    try {
      if (await this.cacheGet("auth", `notice:invalid:${kind}`)) return; // 冷却中
      if (!this.adminIds.length) return;
      const url = await this.buildLoginUrl(kind);
      const keyboard = url
        ? { inline_keyboard: [[{ text: kind === "cookie" ? "更新 Cookie" : "重新登录 DeviantArt", url }]] }
        : undefined;
      const text =
        "⚠️ DeviantArt 登录已失效\n\n" +
        (kind === "cookie" ? "原因：Cookie 会话已失效，请使用 /cookies 更新。\n" : "原因：refresh token invalid。\n") +
        "成熟内容和部分登录后资源可能只能获得公开预览。\n" +
        "在 Telegram 对 Bot 发送 /login 即可重新授权（无需重启）。";
      for (const chatId of this.adminIds) {
        await this.sendTelegram?.("sendMessage", {
          chat_id: chatId, text,
          ...(keyboard ? { reply_markup: keyboard } : {}),
          disable_notification: false,
        });
      }
      await this.cacheSet("auth", `notice:invalid:${kind}`, true, COOLDOWN_SECONDS);
    } catch {
      // 通知失败不影响主链路。
    }
  }

  async notifyRecovered(kind = "oauth", force = false) {
    try {
      const wasNotified = await this.cacheGet("auth", `notice:invalid:${kind}`);
      await this.cacheSet("auth", `notice:invalid:${kind}`, null, 1); // 清冷却
      if (!wasNotified && !force) return; // 之前没报过失效就不打扰
      for (const chatId of this.adminIds) {
        await this.sendTelegram?.("sendMessage", {
          chat_id: chatId,
          text: "✅ DeviantArt 登录已恢复。",
        });
      }
    } catch {
      // 忽略
    }
  }
}

// 管理员（Bot 所有者）id 列表：只认 ADMIN_IDS；ALLOWED_USER_IDS（普通使用者白名单）不等于管理员。
export function resolveAdminIds(env = {}) {
  return String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}
