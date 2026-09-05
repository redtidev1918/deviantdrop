// Keep native fetch and FormData together: a separate undici version may
// serialize native FormData as the literal string "[object FormData]".
export function createProxyFetch(proxyAgent, directAgent, nativeFetch = globalThis.fetch) {
  return (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    const mediaDirect = /\.(wixmp\.com|deviantart\.net|wixstatic\.com)$/i.test(url.hostname);
    return nativeFetch(input, { ...init, dispatcher: mediaDirect ? directAgent : proxyAgent });
  };
}
