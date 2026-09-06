const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mediaHost = host => /(?:^|\.)(?:wixmp\.com|deviantart\.net|wixstatic\.com)$/.test(host);
export function safeMediaUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && mediaHost(u.hostname) ? u : null; } catch { return null; }
}
export async function fetchPublicMedia(value, init = {}, fetchImpl = globalThis.fetch) {
  let url = safeMediaUrl(value);
  if (!url) throw new Error('Unsupported media host');
  for (let hop=0;hop<4;hop++) {
    const response=await fetchImpl(url.href,{...init,redirect:'manual',signal:init.signal || AbortSignal.timeout(15000)});
    if (![301,302,303,307,308].includes(response.status)) return response;
    await response.body?.cancel();
    const location=response.headers.get('location');
    url=location && safeMediaUrl(new URL(location,url).href);
    if (!url) throw new Error('Unsupported media redirect');
  }
  throw new Error('Too many media redirects');
}

export class PreviewService {
  constructor({baseUrl,cacheGet,cacheSet,fetchImpl = globalThis.fetch}) {
    this.baseUrl=baseUrl?.replace(/\/$/,''); this.cacheGet=cacheGet; this.cacheSet=cacheSet; this.fetchImpl=fetchImpl;
    this.pending=new Map();
  }
  async remember(meta) {
    // Never publish authenticated media URLs; crawler images are resolved anonymously.
    const old=await this.cacheGet('preview',meta.id);
    if (!old) await this.cacheSet('preview',meta.id,{id:meta.id,title:meta.title,author:meta.author||'',sourceUrl:meta.sourceUrl,mediaCount:meta.mediaCount||1},86400);
  }
  async metadata(id) {
    if (!/^\d{1,20}$/.test(id)) return null;
    const cached=await this.cacheGet('preview',id);
    if (cached?.checked) return cached;
    if (this.pending.has(id)) return this.pending.get(id);
    const work=this.resolve(id,cached);
    this.pending.set(id,work);
    try { return await work; } finally { this.pending.delete(id); }
  }
  async resolve(id,cached) {
    let sourceUrl=cached?.sourceUrl;
    if (!sourceUrl) {
      let current=new URL(`https://www.deviantart.com/deviation/${id}`);
      try {
        for(let hop=0;hop<3;hop++) {
          const response=await this.fetchImpl(current.href,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(5000)});
          await response.body?.cancel();
          const location=response.headers.get('location');
          if(!location)break;
          const next=new URL(location,current);
          if(next.protocol!=='https:'||next.username||next.password||next.port||!/(?:^|\.)deviantart\.com$/.test(next.hostname))return null;
          current=next;
        }
        if(!/\/art\//.test(current.pathname))return null;
        sourceUrl=current.href;
      } catch { return null; }
    }
    const endpoint=new URL('https://backend.deviantart.com/oembed');
    endpoint.search=new URLSearchParams({url:sourceUrl,format:'json'});
    let data;
    try {
      const r=await this.fetchImpl(endpoint.href,{redirect:'error',signal:AbortSignal.timeout(8000)});
      data=r.ok ? await r.json() : null;
    } catch { data=null; }
    if (!data && !cached) return null;
    const previewImage=safeMediaUrl(data?.thumbnail_url || (data?.type==='photo' ? data?.url : null))?.href || null;
    const meta={id,title:data?.title||cached?.title||'DeviantArt',author:data?.author_name||cached?.author||'',sourceUrl,previewImage,mediaCount:cached?.mediaCount||1,updatedAt:new Date().toISOString(),checked:true};
    await this.cacheSet('preview',id,meta,data ? 3600 : 300);
    return meta;
  }
  async handle(request) {
    const url=new URL(request.url);
    const match=url.pathname.match(/^\/d\/(\d{1,20})(\/image)?$/);
    if (!match) return new Response('Not found',{status:404});
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const meta=await this.metadata(match[1]);
    if (!meta) return new Response('Preview unavailable',{status:404});
    if (match[2]) {
      if (!meta.previewImage) return new Response('No public preview',{status:404});
      try {
        const r=await fetchPublicMedia(meta.previewImage,{method:request.method},this.fetchImpl);
        if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(r.headers.get('content-type')||'')) {await r.body?.cancel();return new Response('Preview unavailable',{status:502});}
        return new Response(request.method==='HEAD'?null:r.body,{headers:{'Content-Type':r.headers.get('content-type'),'Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'}});
      } catch { return new Response('Preview unavailable',{status:502}); }
    }
    const pageUrl=`${this.baseUrl}/d/${meta.id}`;
    const imageUrl=`${pageUrl}/image`;
    const body=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(meta.title)}</title><meta property="og:title" content="${escape(meta.title)}"><meta property="og:description" content="${escape(meta.author)} · DeviantArt"><meta property="og:type" content="article"><meta property="og:url" content="${escape(pageUrl)}">${meta.previewImage?`<meta property="og:image" content="${escape(imageUrl)}">`:''}<link rel="canonical" href="${escape(meta.sourceUrl)}"></head><body><h1>${escape(meta.title)}</h1><p>${escape(meta.author)}</p>${meta.previewImage?`<img src="${escape(imageUrl)}" alt="作品公开预览" style="max-width:100%;height:auto">`:''}<p><a href="${escape(meta.sourceUrl)}" rel="noopener noreferrer">在 DeviantArt 打开</a></p></body></html>`;
    return new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'}});
  }
}
