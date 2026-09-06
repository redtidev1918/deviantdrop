import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/auth/credential-store.js";
import { CookieStore } from "../src/auth/cookie-store.js";
import { AuthNotifier } from "../src/auth/auth-notifier.js";
import { publicError } from "../src/auth/errors.js";

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), "dd-auth-"));
  return join(dir, name);
}

test("CredentialStore：.env refresh token 首次迁移", () => {
  const path = tmpFile("auth.json");
  const store = new CredentialStore({ path, seedEnvToken: "env-token-1" });
  assert.equal(store.getRefreshToken(), "env-token-1");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.refreshToken, "env-token-1");
  assert.equal(saved.state, "valid");
});

test("CredentialStore：已有 store 后不再 fallback 到 .env（stale token 隔离）", () => {
  const path = tmpFile("auth.json");
  // 先用 env-token seed 落盘
  new CredentialStore({ path, seedEnvToken: "env-token-1" }).getRefreshToken();
  // 新建 store：env 换了一个 stale 值，但 store 文件已是事实来源，不应被覆盖
  const store2 = new CredentialStore({ path, seedEnvToken: "stale-env-token" });
  assert.equal(store2.getRefreshToken(), "env-token-1");
  assert.notEqual(store2.getRefreshToken(), "stale-env-token");
});

test("CredentialStore：refresh token rotate 后立即落盘（原子写），restart 读到最新", () => {
  const path = tmpFile("auth.json");
  const store = new CredentialStore({ path, seedEnvToken: "rot-a" });
  store.getRefreshToken();
  store.save("rot-b"); // 轮换
  assert.equal(store.getRefreshToken(), "rot-b");
  // 模拟 restart：新实例读同一文件
  const afterRestart = new CredentialStore({ path, seedEnvToken: "rot-a" });
  assert.equal(afterRestart.getRefreshToken(), "rot-b", "重启后应使用轮换后的最新 token");
});

test("CredentialStore：invalid 后清空 token 且不再使用 .env 旧值", () => {
  const path = tmpFile("auth.json");
  const store = new CredentialStore({ path, seedEnvToken: "good-then-bad" });
  store.getRefreshToken();
  store.invalidate("refresh_token is invalid");
  assert.equal(store.getRefreshToken(), null, "invalid 后应无可用 token");
  assert.equal(store.isInvalid(), true);
  // 重新加载（restart）：仍然 invalid，绝不回退 env seed
  const afterRestart = new CredentialStore({ path, seedEnvToken: "good-then-bad" });
  assert.equal(afterRestart.getRefreshToken(), null);
  assert.equal(afterRestart.isInvalid(), true);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.refreshToken, null);
  assert.equal(saved.state, "invalid");
});

test("CookieStore：env cookie 首次迁移 + 热更新后无需重建即可读到新值", () => {
  const path = tmpFile("cookies.json");
  const store = new CookieStore({ path, seedEnvCookie: "auth=env1;" });
  assert.equal(store.getCookies(), "auth=env1;");
  // 热更新（模拟将来远程登录写入）
  store.set("auth=hot2; auth_secure=x;");
  assert.match(store.getCookies(), /auth=hot2/);
  // 新实例 restart 读到热更新值
  const afterRestart = new CookieStore({ path, seedEnvCookie: "auth=env1;" });
  assert.match(afterRestart.getCookies(), /auth=hot2/);
});

test("AuthNotifier：失效通知 6h 冷却只发一次；恢复后通知一次并清冷却", async () => {
  const sent = [];
  const mem = new Map();
  const cacheGet = async (ns, k) => mem.get(`${ns}:${k}`) ?? null;
  const cacheSet = async (ns, k, v) => { if (v === null) mem.delete(`${ns}:${k}`); else mem.set(`${ns}:${k}`, v); };
  const sendTelegram = async (method, body) => { sent.push({ method, body }); return {}; };
  const notifier = new AuthNotifier({ cacheGet, cacheSet, sendTelegram, adminIds: ["42"], loginUrl: "https://x/auth/deviantart/start?t=abc" });

  await notifier.notifyInvalid("refresh token invalid");
  await notifier.notifyInvalid("refresh token invalid"); // 冷却中，不再发
  assert.equal(sent.length, 1, "6h 冷却内只通知一次");
  assert.match(sent[0].body.text, /DeviantArt 登录已失效/);
  assert.ok(sent[0].body.reply_markup?.inline_keyboard?.[0]?.[0]?.url, "失效通知应带重新登录按钮");

  // 恢复：应发一次恢复通知并清冷却
  sent.length = 0;
  await notifier.notifyRecovered();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /登录已恢复/);
});

test("AuthNotifier：未处于失效态时恢复不打扰", async () => {
  const sent = [];
  const mem = new Map();
  const cacheGet = async (ns, k) => mem.get(`${ns}:${k}`) ?? null;
  const cacheSet = async (ns, k, v) => { if (v === null) mem.delete(`${ns}:${k}`); else mem.set(`${ns}:${k}`, v); };
  const notifier = new AuthNotifier({ cacheGet, cacheSet, sendTelegram: async (m, b) => { sent.push(b); }, adminIds: ["42"] });
  await notifier.notifyRecovered(); // 之前没报过失效
  assert.equal(sent.length, 0);
});

test("publicError：剥离 secret 后保留可读原文，不再笼统隐藏英文错误", () => {
  assert.match(publicError(new Error("Bad Request: entity begins in a middle of a UTF-16 symbol")), /Bad Request/);
  assert.match(publicError(new Error("fetch failed: token=abc123xxx")), /token=<redacted>/);
  assert.doesNotMatch(publicError(new Error("refresh_token=deadbeef invalid")), /deadbeef/);
  assert.equal(publicError(new Error("")), "服务暂时无法完成该请求，请稍后重试。");
});
