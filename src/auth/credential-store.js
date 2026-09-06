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
  invalidate() {
    this.load();
    this.state = { ...this.state, refreshToken: null, state: 'invalid' };
    this.commit(null, 'invalid', 'refresh_token_invalid');
  }
}
