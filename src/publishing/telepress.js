// TelePress 可选集成：TelePress 只作为「超大图集辅助」与「Telegram 发送失败兜底」，
// 绝不是主链路。任何失败都只返回 null / 抛给调用方吞掉，绝不影响原生 Telegram 发送。
//
// 触发规则（TELEPRESS_MODE）：
//   off（默认空/未配置 URL）  永不调用
//   fallback                  仅 Telegram 发送彻底失败时兜底
//   large-gallery             图片数 > LARGE_GALLERY_THRESHOLD（默认 10）时主动建 Telegraph 页
//   always                    （不推荐）总是建页
// 同一 deviation 建过的 Telegraph URL 会缓存，避免重复发布。
//
// 鉴权：TelePress 侧设置 TELEPRESS_API_KEY 后，这里带 Authorization: Bearer。
// 同机部署建议 TELEPRESS_URL=http://127.0.0.1:<port>。

const LARGE_GALLERY_THRESHOLD = 10;

export class TelePress {
  constructor({ url = "", apiKey = "", mode = "off", cacheGet, cacheSet, fetchImpl = null } = {}) {
    this.url = (url || "").replace(/\/$/, "");
    this.apiKey = apiKey || "";
    this.mode = (mode || "off").toLowerCase();
    this.cacheGet = cacheGet || (async () => null);
    this.cacheSet = cacheSet || (async () => {});
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  enabled() {
    return this.mode !== "off" && !!this.url;
  }

  // 图片数量是否达到「大图集」主动建页门槛。
  shouldPublishLargeGallery(imageCount) {
    return this.enabled() && (this.mode === "large-gallery" || this.mode === "always") && imageCount > LARGE_GALLERY_THRESHOLD;
  }

  // Telegram 失败时是否允许兜底。
  shouldFallback() {
    return this.enabled() && (this.mode === "fallback" || this.mode === "always" || this.mode === "large-gallery");
  }

  cacheKey(deviationId) {
    return `telegraph:${deviationId || "unknown"}`;
  }

  // 返回已缓存的 Telegraph URL（同一作品不重复发布）。
  async getCachedUrl(deviationId) {
    const hit = await this.cacheGet("telepress", this.cacheKey(deviationId));
    return typeof hit === "string" ? hit : (hit?.url || null);
  }

  async setCachedUrl(deviationId, telegraphUrl) {
    await this.cacheSet("telepress", this.cacheKey(deviationId), telegraphUrl, 90 * 24 * 3600);
  }

  // 发布图集。files: [{ data: ArrayBuffer/Buffer/Uint8Array, filename, contentType }]
  // 返回 { url } 或 null（失败/未启用）。永不抛出（兜底语义）。
  async publishGallery({ deviationId, title = "", files = [], link = "", tags = "" } = {}) {
    if (!this.enabled()) return null;
    const cached = await this.getCachedUrl(deviationId);
    if (cached) return { url: cached, cached: true };
    try {
      const form = new FormData();
      files.forEach((f, i) => {
        const blob = new Blob([f.data], { type: f.contentType || "image/jpeg" });
        form.append("files", blob, f.filename || `image-${i + 1}.jpg`);
      });
      if (title) form.append("title", title);
      if (tags) form.append("tags", tags);
      if (link) form.append("link", link);
      const headers = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(`${this.url}/publish/gallery`, {
        method: "POST",
        body: form,
        headers,
        signal: AbortSignal.timeout(120_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        console.error("TelePress publish 失败:", response.status, data?.detail || data?.status || "");
        return null;
      }
      await this.setCachedUrl(deviationId, data.url);
      return { url: data.url, cached: false };
    } catch (error) {
      console.error("TelePress publish 异常（不影响 Telegram 发送）:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async health() {
    if (!this.enabled()) return { configured: false };
    try {
      const headers = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(`${this.url}/`, { headers, signal: AbortSignal.timeout(5_000) });
      return { configured: true, ok: response.ok };
    } catch {
      return { configured: true, ok: false };
    }
  }
}
