// Web OAuth 登录的 HTTP 路由处理（/auth/deviantart/start|callback）。
// 与运行时无关：poll / webhook 模式都把请求转发到这里。flow 为 OAuthLoginFlow 实例
// （由 main.js 装配并注入 env.authFlow）。不记录 code / token / secret。

import { LOGIN_HTML_OK, LOGIN_HTML_FAIL } from "./oauth-login.js";

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// 工厂：传入 OAuthLoginFlow，返回 async (request) => Response。
export function createAuthRequestHandler(flow) {
  return async function handleAuthRequest(request) {
    const url = new URL(request.url);
    try {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!flow?.configured?.()) return html(LOGIN_HTML_FAIL("服务器未配置 OAuth 登录（缺少 CLIENT_ID 或 PUBLIC_BASE_URL）。"), 503);

      if (url.pathname === "/auth/deviantart/start") {
        const loginToken = url.searchParams.get("t") || "";
        const authorizeUrl = flow.start(loginToken); // 校验/消费一次性 token；失败抛 400
        return Response.redirect(authorizeUrl, 302);
      }

      if (url.pathname === "/auth/deviantart/callback") {
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        const error = url.searchParams.get("error") || "";
        await flow.callback({ code, state, error }); // 成功落盘 CredentialStore
        return html(LOGIN_HTML_OK, 200);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return html(LOGIN_HTML_FAIL(error?.message), error?.status || 500);
    }
  };
}
