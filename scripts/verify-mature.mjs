// 端到端验证：用热落盘的网页登录 Cookie 调 _puppy/init，解析成熟多图作品的主图+附加页，
// 实际下载确认未打码（200 + image）。只读 CookieStore，绝不使用 refresh token / OAuth 端点。
import { readFileSync } from 'node:fs';

const USERNAME = process.argv[2] || 'mrjoelpreggoart';
const DEVID = process.argv[3] || '1376900771';

const cookies = JSON.parse(readFileSync('/data/auth/deviantart-cookies.json', 'utf8')).cookies;
if (!cookies || !/auth=/.test(cookies)) { console.error('没有网页登录 Cookie'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const blur = (u) => (/blur_/.test(u || '') ? 'BLUR' : 'ok');

// 1) 带 cookie 取 CSRF
const home = await fetch('https://www.deviantart.com/', { headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: cookies } });
const homeHtml = await home.text();
const csrf = homeHtml.match(/window\.__CSRF_TOKEN__\s*=\s*'([^']+)'/)?.[1] || homeHtml.match(/window\.__CSRF_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
const loggedIn = /"isLoggedIn":true|data-userid/.test(homeHtml);
console.log(`home HTTP ${home.status} csrf=${csrf ? 'yes(' + csrf.length + ')' : 'NO'} loggedIn=${loggedIn}`);
if (!csrf) { console.error('取不到 CSRF（cookie 可能无效）'); process.exit(1); }

// 2) init
const ep = new URL('https://www.deviantart.com/_puppy/dadeviation/init');
ep.searchParams.set('deviationid', DEVID);
ep.searchParams.set('username', USERNAME);
ep.searchParams.set('type', 'art');
ep.searchParams.set('include_session', 'false');
ep.searchParams.set('mature_content', 'true');
ep.searchParams.set('csrf_token', csrf);
const r = await fetch(ep, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookies, Referer: `https://www.deviantart.com/${USERNAME}/art/${DEVID}` } });
console.log('init HTTP', r.status);
if (!r.ok) { console.log((await r.text()).slice(0, 200)); process.exit(1); }
const dev = (await r.json()).deviation;
console.log(`isMature=${dev?.isMature} isMultiMedia=${dev?.isMultiMedia} extras=${dev?.extended?.additionalMedia?.length || 0}`);

function appendTok(base, tok) { const t = Array.isArray(tok) ? tok[0] : tok; return base + (t ? (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : ''); }
function rawUrl(media) { return media?.baseUri ? appendTok(media.baseUri, media.token) : null; }

const targets = [];
const mainUrl = rawUrl(dev.media);
if (mainUrl) targets.push(['MAIN', mainUrl]);
for (const [i, e] of (dev.extended?.additionalMedia || []).entries()) {
  const u = rawUrl(e.media);
  if (u) targets.push([`EXTRA[${i}]`, u]);
}

// 3) 实际下载（签名 CDN，不带 cookie）
let allOk = true;
for (const [label, u] of targets) {
  try {
    const dr = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.deviantart.com/' }, signal: AbortSignal.timeout(20000) });
    const ct = dr.headers.get('content-type') || '';
    const len = dr.headers.get('content-length') || '?';
    const good = dr.status === 200 && /^image\//.test(ct);
    if (!good) allOk = false;
    dr.body && dr.body.cancel();
    console.log(`  ${label}: HTTP ${dr.status} ${ct} len=${len} blurStr=${blur(u)} ${good ? '✓ 未打码' : '✗'}`);
  } catch (e) { allOk = false; console.log(`  ${label}: ERR ${e.message}`); }
}
console.log(allOk ? '\nRESULT: 全部图片未打码可下载 ✓' : '\nRESULT: 存在问题 ✗');
process.exit(allOk ? 0 : 2);
