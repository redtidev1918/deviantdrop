#!/usr/bin/env node
// 服务器端：接收本机一键登录器推来的 {code, verifier, redirectUri, cookies, clientId}，
// 用 code + CLIENT_SECRET 换 refresh token，热落盘 CredentialStore + CookieStore。
// 在容器内以 node 用户运行（直接写 /data/auth），写完即生效，无需重启。
//
// 用法：node /app/scripts/dd-exchange.mjs '<base64-json>'
import { CredentialStore } from '../src/auth/credential-store.js';
import { CookieStore } from '../src/auth/cookie-store.js';
import { join } from 'node:path';

const AUTH_DIR = process.env.AUTH_DIR || '/data/auth';
const raw = process.argv[2];
if (!raw) { console.error('missing payload'); process.exit(1); }

let payload;
try { payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
catch { console.error('bad payload'); process.exit(1); }

const { code, verifier, redirectUri, cookies, clientId } = payload;
if (!code || !verifier || !redirectUri) { console.error('payload 缺少 code/verifier/redirectUri'); process.exit(1); }

const client_id = clientId || process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
if (!client_id) { console.error('容器内缺少 CLIENT_ID'); process.exit(1); }

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  client_id,
  redirect_uri: redirectUri,
  code_verifier: verifier,
});
if (client_secret) body.set('client_secret', client_secret);

const res = await fetch('https://www.deviantart.com/oauth2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
  signal: AbortSignal.timeout(20000),
});
const data = await res.json().catch(() => null);
if (!res.ok || !data?.refresh_token) {
  console.error(`授权交换失败：HTTP ${res.status} ${data?.error_description || data?.error || ''}`);
  process.exit(1);
}

const credentialStore = new CredentialStore({ path: join(AUTH_DIR, 'deviantart.json') });
credentialStore.save(data.refresh_token);

let cookieStatus = '未提供';
if (cookies && /auth=/.test(cookies)) {
  const cookieStore = new CookieStore({ path: join(AUTH_DIR, 'deviantart-cookies.json') });
  cookieStore.set(cookies);
  cookieStatus = '已保存（auth/auth_secure/userinfo）';
}

console.log(`OK oauth=valid refresh_token 已轮换落盘；网页 Cookie ${cookieStatus}`);
