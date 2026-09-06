// DeviantArt Web OAuth 登录（VPS 端）：管理员 /login → 拿到一次性链接 → 浏览器授权
// → callback 用 authorization code + PKCE 换 refresh token → 写入 CredentialStore 立即生效，
// 无需 SSH / SCP / 改 .env / 重启 Docker。
//
// 安全要点：
//   - login token：crypto 随机、单次使用、TTL 5 分钟，不含任何 secret；
//   - OAuth state：crypto 随机、绑定 PKCE verifier、TTL 10 分钟、用完即删；
//   - 全程不记录 code / access token / refresh token / client secret。

import { createHash, randomBytes } from "node:crypto";

const AUTHORIZE = "https://www.deviantart.com/oauth2/authorize";
const TOKEN = "https://www.deviantart.com/oauth2/token";
const SCOPES = "basic browse";

const LOGIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 内存态的 login token / OAuth state（单进程足够；poll 与 HTTP server 同一进程）。
export class OAuthLoginFlow {
  constructor({ clientId, clientSecret, redirectUri, credentialStore, onTokenSaved = null }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.credentialStore = credentialStore;
    this.onTokenSaved = onTokenSaved;
    this.loginTokens = new Map(); // token -> { createdAt }
    this.states = new Map(); // state -> { verifier, createdAt }
  }

  configured() {
    try { const u = new URL(this.redirectUri); return Boolean(this.clientId && u.protocol === "https:" && !u.username && !u.password); } catch { return false; }
  }

  // 管理员 /login：签发一次性 login token，拼出 /auth/deviantart/start 链接。
  issueLoginToken(purpose = "oauth") {
    const token = b64url(randomBytes(32));
    this.loginTokens.set(token, { createdAt: Date.now(), purpose });
    this.gc();
    return token;
  }

  // 校验并消费一次性 login token（单次使用 + TTL）。
  consumeLoginToken(token, purpose = "oauth") {
    const rec = this.loginTokens.get(token);
    if (!rec || rec.purpose !== purpose) return false;
    this.loginTokens.delete(token);
    if (Date.now() - rec.createdAt > LOGIN_TOKEN_TTL_MS) return false;
    return true;
  }

  // /start：校验 login token 后创建 state + PKCE，返回 DA 授权 URL。
  start(loginToken) {
    if (!this.configured()) throw new Error("OAuth 未配置 CLIENT_ID / PUBLIC_BASE_URL");
    if (!this.consumeLoginToken(loginToken)) {
      throw Object.assign(new Error("登录链接无效或已过期，请在 Telegram 重新执行 /login。"), { status: 400 });
    }
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(24));
    this.states.set(state, { verifier, createdAt: Date.now() });
    this.gc();
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return url.toString();
  }

  // /callback：严格校验 state，用 code + verifier 换 token，落盘 CredentialStore。
  async callback({ code, state, error }) {
    const rec = this.states.get(state);
    if (!rec) throw Object.assign(new Error("OAuth state 无效，请重新执行 /login。"), { status: 400 });
    this.states.delete(state);
    if (Date.now() - rec.createdAt > STATE_TTL_MS) {
      throw Object.assign(new Error("OAuth 登录已过期，请重新执行 /login。"), { status: 400 });
    }
    if (error) throw Object.assign(new Error("授权被拒绝，请重新登录。"), { status: 400 });
    if (!code || typeof code !== "string") throw Object.assign(new Error("缺少授权码，请重新登录。"), { status: 400 });
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_verifier: rec.verifier,
    });
    if (this.clientSecret) params.set("client_secret", this.clientSecret);

    const response = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "DeviantDrop" },
      body: params.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.refresh_token) {
      throw Object.assign(new Error("DeviantArt 授权交换失败，请重试。"), { status: 502 });
    }
    // 热生效：写入 CredentialStore（原子落盘），清 access-token 缓存由 onTokenSaved 处理。
    this.credentialStore.save(data.refresh_token);
    await this.onTokenSaved?.();
    return { ok: true };
  }

  gc() {
    const now = Date.now();
    for (const [k, v] of this.loginTokens) if (now - v.createdAt > LOGIN_TOKEN_TTL_MS) this.loginTokens.delete(k);
    for (const [k, v] of this.states) if (now - v.createdAt > STATE_TTL_MS) this.states.delete(k);
  }
}

export const LOGIN_HTML_OK = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeviantArt 登录成功</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0b0e11;color:#e6edf3}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 8px}.ok{color:#3fb950;font-size:40px;margin-bottom:8px}p{color:#9da7b3;margin:8px 0}</style></head>
<body><div class="card"><div class="ok">✓</div><h1>DeviantArt 登录成功</h1><p>已在服务器生效，可以关闭本页面回到 Telegram。</p></div></body></html>`;

export const LOGIN_HTML_FAIL = (message) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录失败</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0b0e11;color:#e6edf3}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 8px}.x{color:#f85149;font-size:40px;margin-bottom:8px}p{color:#9da7b3;margin:8px 0}</style></head>
<body><div class="card"><div class="x">✕</div><h1>DeviantArt 登录失败</h1><p>${String(message || "请回到 Telegram 重新执行 /login。").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"})[c])}</p></div></body></html>`;
