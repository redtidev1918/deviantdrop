import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthLoginFlow } from "../src/auth/oauth-login.js";
import { CredentialStore } from "../src/auth/credential-store.js";
import { createAuthRequestHandler } from "../src/auth/http-auth.js";

function setup({ tokenResponse } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dd-httpauth-"));
  const store = new CredentialStore({ path: join(dir, "auth.json") });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return Response.json(tokenResponse || { refresh_token: "rt-from-web", access_token: "acc", expires_in: 3600 });
    }
    throw new Error("unexpected " + url);
  };
  const flow = new OAuthLoginFlow({
    clientId: "cid", clientSecret: "csec",
    redirectUri: "https://bot.example.com/auth/deviantart/callback",
    credentialStore: store, onTokenSaved: async () => { store._savedHook = true; },
  });
  const handler = createAuthRequestHandler(flow);
  return {
    handler, flow, store,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

test("GET /auth/deviantart/start?t=<一次性token> → 302 到 DeviantArt 授权页", async () => {
  const { handler, flow, restore } = setup();
  const t = flow.issueLoginToken();
  const res = await handler(new Request(`https://bot.example.com/auth/deviantart/start?t=${t}`));
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /^https:\/\/www\.deviantart\.com\/oauth2\/authorize/);
  assert.match(loc, /code_challenge=/);
  // 一次性 token 已消费：再次用它会失败
  const res2 = await handler(new Request(`https://bot.example.com/auth/deviantart/start?t=${t}`));
  assert.equal(res2.status, 400);
  restore();
});

test("GET /auth/deviantart/callback?code&state → 换 token 成功并返回成功 HTML", async () => {
  const { handler, flow, store, restore } = setup();
  const t = flow.issueLoginToken();
  const authRes = await handler(new Request(`https://bot.example.com/auth/deviantart/start?t=${t}`));
  const state = new URL(authRes.headers.get("location")).searchParams.get("state");
  const res = await handler(new Request(`https://bot.example.com/auth/deviantart/callback?code=thecode&state=${state}`));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /登录成功/);
  assert.equal(store.getRefreshToken(), "rt-from-web");
  restore();
});

test("callback 错误（用户拒绝授权）返回失败 HTML，不泄漏 secret", async () => {
  const { handler, flow, restore } = setup();
  const t = flow.issueLoginToken();
  const authRes = await handler(new Request(`https://bot.example.com/auth/deviantart/start?t=${t}`));
  const state = new URL(authRes.headers.get("location")).searchParams.get("state");
  const res = await handler(new Request(`https://bot.example.com/auth/deviantart/callback?error=access_denied&state=${state}`));
  const body = await res.text();
  assert.match(body, /登录失败/);
  assert.doesNotMatch(body, /client_secret|refresh_token|csec/);
  restore();
});

test("未配置 OAuth 时 /auth 返回 503 友好页", async () => {
  const handler = createAuthRequestHandler({ configured: () => false, start: () => {}, callback: async () => {} });
  const res = await handler(new Request("https://x/auth/deviantart/start?t=x"));
  assert.equal(res.status, 503);
});
