#!/usr/bin/env node
// DeviantArt 用户 OAuth 登录（一次性）：输出 refresh_token，用于 DeviantDrop 的
// DA_REFRESH_TOKEN 环境变量。登录后 Bot 会在服务器自动续期，不再需要 Cookie。
//
// 用法：
//   node scripts/da-login.mjs <client_id> [client_secret] [redirect_port]
//
// 前提：在 deviantart.com/developers 你的 App 的「OAuth2 Redirect URI Whitelist」
// 里加入：http://127.0.0.1:8787/callback （本地回环地址；这一步只需一次）。
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const AUTHORIZE = "https://www.deviantart.com/oauth2/authorize";
const TOKEN = "https://www.deviantart.com/oauth2/token";
const SCOPES = "basic browse";

const [clientId, clientSecret = "", portArg] = process.argv.slice(2);
const port = Number(portArg || 8787);
if (!clientId) {
  console.error("用法: node scripts/da-login.mjs <client_id> [client_secret] [port]");
  process.exit(1);
}

function b64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const verifier = b64url(randomBytes(64));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const redirectUri = `http://127.0.0.1:${port}/callback`;

const authUrl = new URL(AUTHORIZE);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: SCOPES,
  state: "devdeviandrop",
  code_challenge: challenge,
  code_challenge_method: "S256",
});

console.log("\n在浏览器打开并完成授权：\n\n  " + authUrl.toString() + "\n");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, redirectUri);
    if (!url.pathname.startsWith("/callback")) {
      res.writeHead(404).end();
      return;
    }
    const codeParam = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (error) {
      res.end("授权被拒绝: " + error + "，可关闭本页");
      server.close();
      reject(new Error("authorization error: " + error));
      return;
    }
    res.end("授权成功，可关闭本页返回终端。");
    server.close();
    resolve(codeParam);
  });
  server.listen(port, "127.0.0.1");
});

if (!code) {
  console.error("未取得授权码");
  process.exit(1);
}

const tokenParams = new URLSearchParams({
  grant_type: "authorization_code",
  code,
  client_id: clientId,
  redirect_uri: redirectUri,
  code_verifier: verifier,
});
if (clientSecret) tokenParams.set("client_secret", clientSecret);

const response = await fetch(TOKEN, { method: "POST", body: tokenParams });
const data = await response.json().catch(() => null);
if (!response.ok || !data?.refresh_token) {
  console.error("换取 token 失败:", response.status, data?.error_description || data?.error || "");
  process.exit(1);
}

console.log("\n登录成功！把下面的 refresh_token 填到服务器 .env 的 DA_REFRESH_TOKEN=：\n");
console.log(data.refresh_token);
console.log("\n（access token 有效期 " + (data.expires_in || "?") + " 秒，Bot 会自动续期）\n");
