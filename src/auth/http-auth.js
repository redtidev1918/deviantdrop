import { LOGIN_HTML_OK, LOGIN_HTML_FAIL } from "./oauth-login.js";

const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" };
const html = (body, status = 200) => new Response(body, { status, headers });

export function createAuthRequestHandler(flow, cookieStore, onCookiesChanged = null) {
  return async request => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/deviantart/cookies" && cookieStore) {
        if (request.method === "GET") {
          if (!flow.consumeLoginToken(url.searchParams.get("t"), "cookies")) return html(LOGIN_HTML_FAIL("链接无效或过期"), 400);
          const token = flow.issueLoginToken("cookies-save");
          return html(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>更新 Cookie</title><h1>更新 DeviantArt Cookie</h1><p>OAuth 不会读取浏览器 Cookie。此兼容入口仅接受你手动复制的 Cookie，不保存浏览器密码。</p><form method="post"><input type="hidden" name="t" value="${token}"><textarea name="cookies" required maxlength="16384" autocomplete="off" aria-label="Cookie"></textarea><button>保存并热更新</button></form></html>`);
        }
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (request.headers.get("Origin") !== new URL(flow.redirectUri).origin) return html(LOGIN_HTML_FAIL("来源无效"), 403);
        const raw = await request.text();
        if (raw.length > 20000) return new Response("Payload too large", { status: 413 });
        const form = new URLSearchParams(raw);
        if (!flow.consumeLoginToken(form.get("t"), "cookies-save")) return html(LOGIN_HTML_FAIL("链接无效或过期"), 400);
        cookieStore.set(form.get("cookies"));
        await onCookiesChanged?.();
        return html("<!doctype html><meta charset=utf-8><title>已保存</title>Cookie 已保存并立即生效，可以关闭本页。");
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!flow?.configured?.()) return html(LOGIN_HTML_FAIL("服务器未配置 OAuth 登录。"), 503);
      if (url.pathname === "/auth/deviantart/start") {
        const authorizeUrl = flow.start(url.searchParams.get("t") || "");
        const state = new URL(authorizeUrl).searchParams.get("state");
        return new Response(null, { status: 302, headers: { ...headers, Location: authorizeUrl, "Set-Cookie": `dd_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth/deviantart; Max-Age=600` } });
      }
      if (url.pathname === "/auth/deviantart/callback") {
        const state = url.searchParams.get("state") || "";
        const browserState = request.headers.get("Cookie")?.match(/(?:^|;\s*)dd_oauth=([^;]+)/)?.[1];
        if (!state || browserState !== state) return html(LOGIN_HTML_FAIL("OAuth 浏览器会话无效，请重新登录。"), 400);
        await flow.callback({ code: url.searchParams.get("code") || "", state, error: url.searchParams.get("error") || "" });
        const response = html(LOGIN_HTML_OK);
        response.headers.set("Set-Cookie", "dd_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/auth/deviantart; Max-Age=0");
        return response;
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return html(LOGIN_HTML_FAIL(error?.status === 400 ? error.message : "保存或授权失败，请重试；若持续失败请检查服务器存储。"), error?.status || 500);
    }
  };
}
