import { readFileSync } from 'node:fs';
import { atomicJson } from './atomic-json.js';

export class CredentialStore {
  constructor({ path = '/data/auth/deviantart.json', seedEnvToken = null } = {}) {
    this.path = path;
    this.seedEnvToken = seedEnvToken;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!data || data.version !== 1 || !['valid', 'invalid', 'absent'].includes(data.state)) throw new SyntaxError('Invalid credentials');
      this.state = data;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A corrupt existing file is invalid, never a reason to resurrect the env seed.
      const missing = error.code === 'ENOENT';
      this.state = { version: 1, refreshToken: null, state: missing ? 'absent' : 'invalid', updatedAt: null, lastError: null };
      if (missing) this.commit(this.seedEnvToken || null, this.seedEnvToken ? 'valid' : 'absent');
    }
    this.seedEnvToken = null;
    return this.state;
  }

  getRefreshToken() { return this.load().state === 'valid' ? this.state.refreshToken || null : null; }
  isInvalid() { return this.load().state === 'invalid'; }
  getState() { const s = this.load(); return { state: s.state, updatedAt: s.updatedAt, hasToken: !!this.getRefreshToken() }; }

  commit(refreshToken, state, lastError = null) {
    const next = { version: 1, refreshToken, state, updatedAt: new Date().toISOString(), lastError };
    atomicJson(this.path, next); // Failure propagates; OAuth must not claim a successful save.
    this.state = next;
  }
  save(token) {
    if (typeof token !== 'string' || !token.trim()) throw new Error('Missing refresh token');
    this.commit(token, 'valid');
  }

  // 重新从磁盘读入最新状态（多进程共享同一凭据文件：外部轮换/Web 登录后内存会过期）。
  reload() {
    this.state = null;
    return this.load();
  }

  // 标记失效（compare-and-clear）：以磁盘当前值为准，仅当它仍是本次失败的那个 token
  // 才清空。Bot 进程内存里的旧 token 可能已被另一进程（隧道登录/重放脚本）轮换掉——
  // 此时文件里已是新 token，绝不能把新 token 一起清成 invalid。返回 true 表示真的清空了，
  // false 表示磁盘已被更新（调用方应重读文件用新 token 重试，而不是宣告登录失效）。
  invalidate(reason = 'refresh_token_invalid', expectedToken = null) {
    this.reload();
    if (expectedToken && this.state.refreshToken !== expectedToken) return false;
    this.commit(null, 'invalid', reason);
    return true;
  }
}
