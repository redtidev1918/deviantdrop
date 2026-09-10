import { readFileSync, statSync } from 'node:fs';
import { atomicJson } from './atomic-json.js';

export const WEB_SESSION_STATUS = Object.freeze({
  MISSING: 'missing',
  UNKNOWN: 'unknown',
  VALID: 'valid',
  EXPIRED: 'expired',
});

export class CookieStore {
  constructor({ path = '/data/auth/deviantart-cookies.json', seedEnvCookie = null } = {}) {
    this.path = path;
    this.seedEnvCookie = seedEnvCookie;
    this.initialized = false;
    this.cookies = null;
    this.state = WEB_SESSION_STATUS.MISSING;
    this.updatedAt = null;
    this.checkedAt = null;
    this.stamp = null;
  }
  load() {
    try {
      const stat = statSync(this.path);
      const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (stamp !== this.stamp) {
        const data = JSON.parse(readFileSync(this.path, 'utf8'));
        this.cookies = typeof data?.cookies === 'string' ? data.cookies || null : null;
        this.state = Object.values(WEB_SESSION_STATUS).includes(data?.state)
          ? data.state
          : (this.cookies ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING);
        this.updatedAt = data?.updatedAt || null;
        this.checkedAt = data?.checkedAt || null;
        this.stamp = stamp;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.cookies = null;
      this.state = WEB_SESSION_STATUS.MISSING;
      this.updatedAt = null;
      this.checkedAt = null;
      if (!this.initialized && error.code === 'ENOENT') this.write(this.seedEnvCookie || null, WEB_SESSION_STATUS.MISSING);
    }
    this.initialized = true;
    this.seedEnvCookie = null;
    return this;
  }
  getCookies() { return this.load().cookies; }
  available() { return !!this.getCookies(); }
  getState() {
    this.load();
    return {
      state: this.cookies ? this.state : WEB_SESSION_STATUS.MISSING,
      hasCookie: !!this.cookies,
      updatedAt: this.updatedAt,
      checkedAt: this.checkedAt,
    };
  }
  write(cookies, state = cookies ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING) {
    const now = new Date().toISOString();
    atomicJson(this.path, {
      version: 1,
      cookies,
      state: cookies ? state : WEB_SESSION_STATUS.MISSING,
      updatedAt: cookies ? now : this.updatedAt,
      checkedAt: state === WEB_SESSION_STATUS.VALID || state === WEB_SESSION_STATUS.EXPIRED ? now : this.checkedAt,
    });
    this.cookies = cookies;
    this.state = cookies ? state : WEB_SESSION_STATUS.MISSING;
    this.updatedAt = cookies ? now : this.updatedAt;
    this.checkedAt = state === WEB_SESSION_STATUS.VALID || state === WEB_SESSION_STATUS.EXPIRED ? now : this.checkedAt;
    this.initialized = true;
    this.stamp = null;
  }
  set(cookies) {
    if (typeof cookies !== 'string' || !cookies.trim() || cookies.length > 16384 || /[\r\n\0]/.test(cookies)) throw new Error('Cookie 格式无效');
    if (!cookies.split(';').filter(s => s.trim()).every(s => /^\s*[\w-]+=[^;]*$/.test(s))) throw new Error('Cookie 格式无效');
    this.write(cookies.trim(), WEB_SESSION_STATUS.UNKNOWN);
  }
  markStatus(state) {
    if (!Object.values(WEB_SESSION_STATUS).includes(state)) throw new Error(`Unknown web session state: ${state}`);
    this.load();
    if (!this.cookies || state === WEB_SESSION_STATUS.MISSING) return;
    this.write(this.cookies, state);
  }
  clear() { this.write(null, WEB_SESSION_STATUS.MISSING); }
}
