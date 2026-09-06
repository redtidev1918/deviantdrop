import { readFileSync, statSync } from 'node:fs';
import { atomicJson } from './atomic-json.js';

export class CookieStore {
  constructor({ path = '/data/auth/deviantart-cookies.json', seedEnvCookie = null } = {}) {
    this.path = path;
    this.seedEnvCookie = seedEnvCookie;
    this.initialized = false;
    this.cookies = null;
    this.stamp = null;
  }
  getCookies() {
    try {
      const stat = statSync(this.path);
      const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (stamp !== this.stamp) {
        const data = JSON.parse(readFileSync(this.path, 'utf8'));
        this.cookies = typeof data?.cookies === 'string' ? data.cookies || null : null;
        this.stamp = stamp;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.cookies = null;
      if (!this.initialized && error.code === 'ENOENT') this.write(this.seedEnvCookie || null);
    }
    this.initialized = true;
    this.seedEnvCookie = null;
    return this.cookies;
  }
  available() { return !!this.getCookies(); }
  write(cookies) {
    atomicJson(this.path, { version: 1, cookies, updatedAt: new Date().toISOString() });
    this.cookies = cookies;
    this.initialized = true;
    this.stamp = null;
  }
  set(cookies) {
    if (typeof cookies !== 'string' || !cookies.trim() || cookies.length > 16384 || /[\r\n\0]/.test(cookies)) throw new Error('Cookie 格式无效');
    if (!cookies.split(';').filter(s => s.trim()).every(s => /^\s*[\w-]+=[^;]*$/.test(s))) throw new Error('Cookie 格式无效');
    this.write(cookies.trim());
  }
  clear() { this.write(null); }
}
