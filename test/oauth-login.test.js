import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthLoginFlow } from "../src/auth/oauth-login.js";
import { CredentialStore } from "../src/auth/credential-store.js";

function makeFlow({ seedToken = null, tokenResponse = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dd-oauth-"));
  const store = new CredentialStore({ path: join(dir, "auth.json"), seedEnvToken: seedToken });
  const calls = [];
  // 模拟 DA token 端点
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).includes("oauth2/token") || String(url).includes("/oauth2/token")) {
      return Response.json(tokenResponse || { refresh_token: "new-refresh-xyz", access_token: "acc", expires_in: 3600 });
    }
    throw new Error("unexpected fetch " + url);
  };
  const flow = new OAuthLoginFlow({
    clientId: "cid", clientSecret: "csec",
    redirectUri: "https://bot.example.com/auth/deviantart/callback",
    credentialStore: store, onTokenSaved: null,
  });
  flow._restore = () => { globalThis.fetch = fetchImpl; };
  flow._calls = calls;
  flow._store = store;
  return flow;
}

test("login token 单次使用：第二次消费失败", () => {
  const flow = makeFlow();
  const t = flow.issueLoginToken();
  assert.equal(flow.consumeLoginToken(t), true);
  assert.equal(flow.consumeLoginToken(t), false, "一次性 token 用过即作废");
  assert.equal(flow.consumeLoginToken("not-a-real-token"), false);
});

test("start：消费 login token 后返回 DA 授权 URL（含 PKCE challenge 与 state）", () => {
  const flow = makeFlow();
  const t = flow.issueLoginToken();
  const authUrl = flow.start(t);
  const u = new URL(authUrl);
  assert.equal(u.hostname, "www.deviantart.com");
  assert.ok(u.searchParams.get("code_challenge"));
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("state"));
  assert.equal(u.searchParams.get("redirect_uri"), "https://bot.example.com/auth/deviantart/callback");
  // login token 已被 start 消费：不能再用它 start
  assert.throws(() => flow.start(t), /无效或已过期/);
  flow._restore();
});

test("start：无效/缺失 login token 被拒绝", () => {
  const flow = makeFlow();
  assert.throws(() => flow.start("bogus"), /无效或已过期/);
  flow._restore();
});

test("callback：state 错误被拒绝", async () => {
  const flow = makeFlow();
  await assert.rejects(flow.callback({ code: "c", state: "wrong-state" }), /state 无效/);
  flow._restore();
});

test("callback：完整流程换 token 并写入 CredentialStore（热生效）", async () => {
  const flow = makeFlow();
  const loginToken = flow.issueLoginToken();
  const authUrl = new URL(flow.start(loginToken));
  const state = authUrl.searchParams.get("state");
  // state 用过即删：第一次 callback 成功
  const result = await flow.callback({ code: "auth-code", state });
  assert.equal(result.ok, true);
  assert.equal(flow._store.getRefreshToken(), "new-refresh-xyz", "refresh token 应立即写入 store");
  // 同一 state 不能二次使用
  await assert.rejects(flow.callback({ code: "auth-code", state }), /state 无效/);
  flow._restore();
});

test("login token 过期被拒绝（TTL）", async () => {
  const flow = makeFlow();
  const t = flow.issueLoginToken();
  // 手动把创建时间调到 6 分钟前
  const rec = flow.loginTokens.get(t);
  rec.createdAt = Date.now() - 6 * 60 * 1000;
  assert.throws(() => flow.start(t), /无效或已过期/);
  flow._restore();
});
