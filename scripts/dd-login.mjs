#!/usr/bin/env node
// 一键登录（在你自己的电脑上运行）。
//
// 为什么需要它：成熟作品的附加页只有「网页登录 Cookie」能取到未打码画面，而 Cookie 是
// DeviantArt 域的，跨域读不到、服务器反代登录页又会被 AWS WAF 的主机/IP 校验挡住。
// 本脚本在你本机用真实 Chrome 打开 DeviantArt 官方登录页（WAF 由你的浏览器正常通过），
// 你登录一次，脚本经 Chrome DevTools Protocol 同时拿到 ① OAuth 授权回调的 code 和
// ② 网页登录 Cookie（auth/auth_secure/userinfo），然后把这两样一次性推送到你的 VPS
// ——由 VPS 用 CLIENT_SECRET 换 refresh token 并热落盘，无需手动复制、无需重启。
//
// 用法：
//   node scripts/dd-login.mjs                 # 交互式：提示输入 VPS 地址
//   VPS=root@1.2.3.4 node scripts/dd-login.mjs
//   CLIENT_ID=76744 VPS=root@host node scripts/dd-login.mjs
//
// 依赖：本机已装 Google Chrome；Node >= 22（自带 WebSocket/fetch）。不安装任何 npm 包。

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const CLIENT_ID = process.env.CLIENT_ID || '76744'; // DeviantDrop 的公开 DA app id
const VPS = process.env.VPS || '';
const VPS_DIR = process.env.VPS_DIR || '/opt/deviantdrop';
const DEBUG_PORT = 9333;
const CALLBACK_PORT = 8787; // 必须与 DA app 登记的 redirect_uri 端口一致
const OK_PAGE = `<!doctype html><meta charset=utf-8><title>登录成功</title><body style="font-family:sans-serif;text-align:center;padding:80px;background:#0b0e11;color:#e6edf3"><h1 style="color:#3fb950">✓ DeviantArt 登录成功</h1><p>请回到终端 / Telegram，登录状态正在自动保存到服务器，可以关闭本页。</p></body>`;

// —— 定位本机 Chrome ——
function chromePath() {
  const p = platform();
  const candidates = p === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : p === 'win32'
      ? [join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
         join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
         join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
         '/snap/bin/chromium', '/usr/bin/microsoft-edge'];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('找不到 Chrome/Chromium/Edge，请先安装 Google Chrome，或用浏览器手动登录方案。');
  return found;
}

// 生成 PKCE
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function pkce() {
  const { randomBytes, createHash } = await import('node:crypto');
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(randomBytes(24)) };
}

// 远程调试端口可能被上一次残留的 Chrome 占用：探测并选一个空闲端口。
async function pickDebugPort(preferred = DEBUG_PORT) {
  const { createServer } = await import('node:http');
  for (const port of [preferred, preferred + 1, preferred + 2, preferred + 3]) {
    const ok = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  return preferred;
}

// 连接一个新开的、带远程调试的 Chrome，导航到 authorize 页，等待回调 / 登录，
// 同时轮询 deviantart.com 的 cookie。返回 { code, state, cookies }。
async function runBrowser(authorizeUrl) {
  const profileDir = join(homedir(), '.config', 'deviantdrop', 'chrome-login-profile');
  mkdirSync(profileDir, { recursive: true });
  const debugPort = await pickDebugPort();
  // detached: 让 Chrome 成为独立进程组组长，结束时杀整个组（否则 helper/GPU 子进程
  // 会残留并继续占用远程调试端口，导致下次运行连不上）。Windows 无进程组，直接 kill。
  const isWin = platform() === 'win32';
  const chrome = spawn(chromePath(), [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], detached: !isWin });

  try {
    // 等 DevTools 就绪
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(authorizeUrl)}`, { method: 'PUT' });
        if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(500);
    }
    if (!wsUrl) throw new Error('Chrome 远程调试端口未就绪（可能被残留 Chrome 占用，请关闭后重试）。');

    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
      else if (m.method) events.push(m);
    };
    await new Promise((res) => (ws.onopen = res));
    const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: authorizeUrl });

    const SESSION_COOKIES = ['auth', 'auth_secure', 'userinfo'];
    // 读当前 DA 登录 cookie；返回 { cookies: 'k=v; …', hasSession }。
    const readSession = async () => {
      const ctx = await send('Network.getCookies', { urls: ['https://www.deviantart.com/'] });
      let da = ctx.cookies || [];
      if (!SESSION_COOKIES.every((n) => da.some((c) => c.name === n))) {
        const all = (await send('Network.getAllCookies')).cookies || [];
        da = all.filter((c) => /(^|\.)deviantart\.com$/i.test(c.domain));
      }
      const jar = {};
      for (const c of da) if (SESSION_COOKIES.includes(c.name)) jar[c.name] = c.value;
      const cookies = SESSION_COOKIES.filter((n) => jar[n]).map((n) => `${n}=${jar[n]}`).join('; ');
      return { cookies, hasSession: SESSION_COOKIES.every((n) => jar[n]) };
    };

    let result = null;
    const t0 = Date.now();
    const TIMEOUT = Number(process.env.DD_LOGIN_TIMEOUT_MS) || 10 * 60 * 1000; // 用户最多 10 分钟完成登录
    let lastHint = '';

    while (Date.now() - t0 < TIMEOUT) {
      await sleep(1500);
      for (const ev of events.splice(0)) {
        if (ev.method === 'Network.requestWillBeSent') {
          const u = ev.params.request.url;
          // DA 授权后 302 回 redirect_uri（http://127.0.0.1:8787/callback?code=...）。
          // 该端口本机不必在听——我们在网络层拦截这个导航即可拿到 code。
          if (/[?&]code=[^&]+/.test(u) && /[?&]state=/.test(u)) {
            const q = u.includes('?') ? u.slice(u.indexOf('?')) : '';
            const parsed = new URLSearchParams(q);
            const code = parsed.get('code');
            const st = parsed.get('state');
            if (code) result = { code, state: st };
          }
        }
      }

      // 登录 cookie：优先按 www.deviantart.com 上下文取（与 Bot 请求一致），回退全量按域过滤。
      let { cookies, hasSession } = await readSession();

      const href = (await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value || '';
      const loggedInHint = hasSession ? '已检测到登录 Cookie' : /\/join|login|signin/i.test(href) ? '等待你在页面里登录…' : '等待授权…';
      if (loggedInHint !== lastHint) { console.log(loggedInHint); lastHint = loggedInHint; }

      // 拿到 code 后，给网页 cookie 一点落盘时间（通常已就绪），最多再等 ~6 秒。
      if (result) {
        if (!hasSession && Date.now() - t0 < TIMEOUT) {
          for (let i = 0; i < 4 && !hasSession; i++) { await sleep(1500); ({ cookies, hasSession } = await readSession()); }
        }
        ws.close();
        if (!cookies) console.log('⚠️ 未捕获到网页登录 Cookie（OAuth 已成功）：多图附加页可能仍打码，请确认登录的是网页账号。');
        return { code: result.code, state: result.state, cookies };
      }
    }
    ws.close();
    throw new Error('登录超时，请重新运行并在 10 分钟内完成登录。');
  } finally {
    try {
      if (isWin) chrome.kill();
      else process.kill(-chrome.pid); // 杀整个进程组（Chrome + helpers）
    } catch {}
  }
}

// 把 code + verifier + cookie 推送到 VPS：VPS 上 dd-receive.sh 拷进容器跑兑换并热落盘。
// base64 经 stdin 传输，避免命令行参数长度/引号转义问题。
function pushToVps(payload, vps) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  console.log('正在把登录结果推送到服务器并热更新…');
  try {
    return execFileSync('ssh', [vps, `cd ${VPS_DIR} && bash scripts/dd-receive.sh`], {
      encoding: 'utf8',
      input: b64 + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const hint = stderr.includes('Permission denied') || error.status === 255
      ? 'SSH 连不上服务器或未配免密登录：请确认 VPS 地址正确、能 `ssh <VPS>` 直接登录（可用 ssh-copy-id 配置）。'
      : stderr ? `服务器返回：${stderr}` : error.message;
    throw new Error(`推送到服务器失败。${hint}`);
  }
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  let vps = VPS;
  if (!vps) {
    vps = (await rl.question('输入你的服务器 SSH 地址（如 root@1.2.3.4）：')).trim();
  }
  rl.close();
  if (!vps) throw new Error('需要 VPS 地址（设 VPS=root@host 或交互输入）。');

  const { verifier, challenge, state } = await pkce();
  // redirect_uri 必须与 DA app 白名单一致（DeviantDrop 已登记 http://127.0.0.1:8787/callback）。
  // 本机起一个极简服务接这个回调，让用户看到“登录成功”页而不是浏览器报错。
  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  // 回调页仅为让用户看到“登录成功”；code 由 CDP 在网络层拦截，端口被占用也不影响登录。
  const callbackServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(OK_PAGE);
  });
  await new Promise((resolve) => {
    callbackServer.on('error', () => resolve()); // 端口被占用（如残留隧道）：跳过成功页，不影响登录
    callbackServer.listen(CALLBACK_PORT, '127.0.0.1', resolve);
  });

  const authorizeUrl = new URL('https://www.deviantart.com/oauth2/authorize');
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
    scope: 'basic browse', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();

  console.log('\n即将打开 Chrome 进入 DeviantArt 官方登录页。');
  console.log('请在浏览器里登录并点「Authorize/允许」。脚本会自动捕获登录状态。\n');

  try {
    const { code, state: gotState, cookies } = await runBrowser(authorizeUrl.toString());
    if (gotState !== state) throw new Error('OAuth state 不匹配，中止。');

    const out = pushToVps({ code, verifier, redirectUri, cookies, clientId: CLIENT_ID }, vps);
    console.log(out.trim() || '完成。');
    console.log('\n✅ 登录完成：OAuth 与网页 Cookie 已在服务器热生效，无需重启。');
  } finally {
    if (callbackServer.listening) await new Promise((r) => callbackServer.close(r)).catch(() => {});
  }
}

main().catch((e) => { console.error('\n❌ 登录失败：', e.message); process.exit(1); });
