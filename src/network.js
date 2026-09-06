// Keep native fetch and FormData together: a separate undici version may
// serialize native FormData as the literal string "[object FormData]".
//
// 路由 + 双通道兜底（国内 VPS 的关键健壮性）：
//   - 媒体 CDN（wixmp/deviantart.net/wixstatic）国内可直连且更稳：优先直连，连不上再走代理；
//   - 其余（Telegram 长轮询 / DA 官方 API / DA 网页 / archive）：优先走 clash 代理，
//     代理一旦挂了（clash 重启、订阅失效 → ECONNREFUSED）自动回退直连——国内 VPS 实测
//     直连可达 Telegram/DA，保证 clash 中断时 bot 仍能收发。
// 只在「网络层连不上」（连接被拒 / DNS 失败 / 连接超时 / 连接重置）时换一条路重试一次：
// HTTP 4xx/5xx 是服务端的正常响应，不换路；调用方主动 abort / 超时也不换路（signal 已失效）。
const MEDIA_DIRECT_HOST = /\.(wixmp\.com|deviantart\.net|wixstatic\.com)$/i;
const CONNECT_FAILURE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EAI_NODATA|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

function connectErrorCode(error) {
  const codes = [
    error?.code,
    error?.cause?.code,
    ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map((e) => e?.code) : []),
  ].filter(Boolean);
  return codes.find((c) => CONNECT_FAILURE.test(c)) || null;
}

function isAborted(error, signal) {
  if (signal?.aborted) return true;
  const name = error?.name || error?.cause?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function createProxyFetch(proxyAgent, directAgent, nativeFetch = globalThis.fetch) {
  return async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    const isMedia = MEDIA_DIRECT_HOST.test(url.hostname);
    const primary = isMedia ? directAgent : proxyAgent;
    const secondary = isMedia ? proxyAgent : directAgent;
    try {
      return await nativeFetch(input, { ...init, dispatcher: primary });
    } catch (error) {
      const code = connectErrorCode(error);
      if (secondary && code && !isAborted(error, init?.signal)) {
        const from = isMedia ? "直连" : "代理";
        const to = isMedia ? "代理" : "直连";
        console.error(`[net] ${from}连接失败(${code})，切${to}重试: ${url.hostname}${url.pathname.slice(0, 48)}`);
        return nativeFetch(input, { ...init, dispatcher: secondary });
      }
      throw error;
    }
  };
}
