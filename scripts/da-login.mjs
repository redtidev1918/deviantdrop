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
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const AUTHORIZE = "https://www.deviantart.com/oauth2/authorize";
const TOKEN = "https://www.deviantart.com/oauth2/token";
const SCOPES = "basic browse";

const [clientId, clientSecret = "", portArg, serverArg] = process.argv.slice(2);
const server = process.env.SERVER || serverArg || "root@114.55.249.249";
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

console.log("\n授权地址：\n\n  " + authUrl.toString() + "\n");
// 自动打开浏览器（macOS/Windows/Linux 通用降级）
try {
  if (process.platform === "darwin") spawn("open", [authUrl.toString()], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32") spawn("cmd", ["/c", "start", authUrl.toString()], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [authUrl.toString()], { detached: true, stdio: "ignore" }).unref();
  console.log("（已尝试自动打开浏览器）\n");
} catch { /* 打开失败就手动复制上面的链接 */ }

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

// 用 curl 换 token：本机 node fetch 对 deviantart.com 偶发走错代理超时，curl 稳定。
let raw = "";
try {
  const result = await execFileAsync("curl", [
    "-sS", "-m", "60", "-X", "POST", TOKEN,
    "--data", tokenParams.toString(),
  ], { maxBuffer: 1024 * 1024 });
  raw = result.stdout;
} catch (error) {
  raw = (error && error.stdout) || "";
}
const data = JSON.parse(raw || "{}");
if (!data?.refresh_token) {
  console.error("换取 token 失败:", data?.error_description || data?.error || raw || "(空响应)");
  process.exit(1);
}

console.log("\n登录成功！refresh_token 已取得，正在写入 VPS " + server + " …\n");
const tmp = "/tmp/dd_rt.txt";
writeFileSync(tmp, data.refresh_token);
try {
  await execFileAsync("scp", ["-q", tmp, server + ":/tmp/dd_rt.txt"], { timeout: 120000 });
  // 注意：sed 替换串必须用双引号，让远端 shell 展开 $RT；单引号会把字面 "$RT" 写进 .env。
  const remote = "RT=$(cat /tmp/dd_rt.txt) && cd /opt/deviantdrop && " +
    "(grep -q '^DA_REFRESH_TOKEN=' .env && sed -i \"s|^DA_REFRESH_TOKEN=.*|DA_REFRESH_TOKEN=$RT|\" .env || echo \"DA_REFRESH_TOKEN=$RT\" >> .env) && " +
    "chmod 600 .env && docker compose up -d >/dev/null 2>&1 && echo DEPLOYED";
  await execFileAsync("ssh", [server, remote], { timeout: 300000, maxBuffer: 1024 * 1024 });
  console.log("✅ 已写入 /opt/deviantdrop/.env 并重启容器。");
} catch (error) {
  console.error("自动部署失败，请手动把下面 refresh_token 写进 .env 的 DA_REFRESH_TOKEN=：");
  console.log(data.refresh_token);
  console.error(error && error.stderr ? error.stderr : error.message);
}
console.log("\n（access token 有效期 " + (data.expires_in || "?") + " 秒，Bot 会自动续期）\n");
