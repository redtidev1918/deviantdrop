// DeviantArt 登录 Cookie 的热更新存储（二级兼容方案，主认证是 OAuth）。
//
//   - .env 的 DA_COOKIES 只在「store 首次创建且文件里没有 cookie」时迁移一次；
//   - 每次创建网页 session 时动态 getCookies()，store 更新后无需重启 Docker；
//   - 持久化到 /data/auth/deviantart-cookies.json（0600）；
//   - 不默认引入 Playwright；不做反向代理截获登录页（预留扩展点）；
//   - cookie 永不进日志。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = "/data/auth/deviantart-cookies.json";

export class CookieStore {
  constructor({ path = DEFAULT_PATH, seedEnvCookie = null } = {}) {
    this.path = path;
    this.seedEnvCookie = seedEnvCookie;
    this.cookies = null;
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this.cookies;
    this.loaded = true;
    const fileExists = existsSync(this.path);
    if (fileExists) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8"));
        if (raw && typeof raw === "object" && typeof raw.cookies === "string" && raw.cookies) {
          this.cookies = raw.cookies;
        }
      } catch {
        // 文件损坏：以文件为准（视为已建立），不回退 env。
      }
    } else if (this.seedEnvCookie) {
      // 仅当磁盘上从未有过 store 文件时，用 .env 迁移一次。
      this.set(this.seedEnvCookie);
    }
    return this.cookies;
  }

  // 当前 cookie 字符串；未配置返回 null。
  getCookies() {
    this.load();
    return this.cookies || null;
  }

  available() {
    return !!this.getCookies();
  }

  // 热更新 cookie（无需重启）。
  set(cookies) {
    if (!cookies || typeof cookies !== "string") return;
    this.loaded = true;
    this.cookies = cookies.trim();
    this.persist();
  }

  clear() {
    this.load();
    this.cookies = null;
    this.persist();
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, cookies: this.cookies || "", updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      console.error("CookieStore 落盘失败:", error instanceof Error ? error.message : String(error));
    }
  }
}
