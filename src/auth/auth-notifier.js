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
        ? { inline_keyboard: [[{ text: kind === "cookie" ? "恢复多图扩展" : "重新登录 DeviantArt", url }]] }
        : undefined;
      const text = kind === "cookie"
        ? "⚠️ DeviantArt 多图网页扩展会话已失效\n\nOAuth API 仍正常工作：单图、mature 主图与官方 API 可获取的内容不受影响。\n只有部分多图作品的附加页（第 2…N 页）会暂时跳过。\n\n恢复方式（任选）：\n• 私聊发 /cookie，把浏览器里整行 Cookie 粘给我；\n• 或发 /login 看电脑一键登录命令。\n无需重启服务。"
        : "⚠️ DeviantArt OAuth 授权已失效\n\n原因：refresh token 已失效，access token 无法继续自动续期。\n影响：官方 API 不可用，成熟作品的主图会退回网页（可能只有打码预览）。\n请对 Bot 发送 /login 重新授权；无需重启服务。";
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
