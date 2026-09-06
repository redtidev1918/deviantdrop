// DeviantArt OAuth 凭据统一存储。
//
// 设计要点（见本轮改造规范）：
//   - refresh token 是运行时单一事实来源，持久化到 /data/auth/deviantart.json；
//   - .env 的 DA_REFRESH_TOKEN 只在「store 首次创建且文件里没有 token」时迁移一次；
//     store 一旦初始化（哪怕之后 token 失效被清空），都不再回退读 .env 的旧值；
//   - refresh token 每次刷新都会轮换、旧值作废：轮换后立即原子写盘（tmp→rename，0600）；
//   - DA 明确返回 invalid_grant / "refresh_token is invalid" 时：标记 invalid、
//     清空持久化 token、之后不再拿同一个失效 token 反复尝试；
//   - access token 仍是短期内存/缓存（cache），不写进本 store；
//   - token 永不进日志。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = "/data/auth/deviantart.json";

export class CredentialStore {
  constructor({ path = DEFAULT_PATH, seedEnvToken = null } = {}) {
    this.path = path;
    this.seedEnvToken = seedEnvToken; // 仅用于一次性迁移（DA_REFRESH_TOKEN）
    this.state = { version: 1, refreshToken: null, updatedAt: null, state: "absent", lastError: null };
    this.loaded = false;
    this.fileExisted = false;
  }

  load() {
    if (this.loaded) return this.state;
    this.loaded = true;
    let onDisk = null;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw && typeof raw === "object") {
        onDisk = {
          version: 1,
          refreshToken: typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : null,
          updatedAt: raw.updatedAt || null,
          state: raw.state || (raw.refreshToken ? "valid" : "absent"),
          lastError: raw.lastError || null,
        };
      }
    } catch {
      onDisk = null;
    }
    this.fileExisted = !!onDisk;
    // env seed 只在「磁盘上从未有过 store 文件」时发生一次。文件一旦存在
    // （哪怕之后 token 失效被清空为 invalid），都不再回退读 .env 的旧值。
    if (onDisk) {
      this.state = onDisk;
    } else if (this.seedEnvToken) {
      this.save(this.seedEnvToken);
    }
    return this.state;
  }

  // 当前可用的 refresh token；invalid/absent 返回 null（调用方据此走匿名/提示登录）。
  getRefreshToken() {
    this.load();
    if (this.state.state === "invalid") return null;
    return this.state.refreshToken || null;
  }

  isInvalid() {
    this.load();
    return this.state.state === "invalid";
  }

  getState() {
    this.load();
    return { state: this.state.state, updatedAt: this.state.updatedAt, hasToken: !!this.state.refreshToken };
  }

  // 轮换/登录成功：保存最新 refresh token 并标记 valid（立即热生效）。
  save(refreshToken) {
    if (!refreshToken || typeof refreshToken !== "string") return;
    this.loaded = true;
    this.state = {
      version: 1,
      refreshToken,
      updatedAt: new Date().toISOString(),
      state: "valid",
      lastError: null,
    };
    this.persist();
  }

  // 明确失效（invalid_grant / refresh_token invalid）：清空 token、标记 invalid。
  invalidate(reason = "invalid") {
    this.load();
    this.state.refreshToken = null;
    this.state.state = "invalid";
    this.state.updatedAt = new Date().toISOString();
    this.state.lastError = String(reason).slice(0, 200);
    this.persist();
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      // tmp 以 0600 写入，rename 后权限随 inode 保留（原子替换，避免半写文件）。
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      // 落盘失败不应打 token；只报路径级错误。
      console.error("CredentialStore 落盘失败:", error instanceof Error ? error.message : String(error));
    }
  }
}
