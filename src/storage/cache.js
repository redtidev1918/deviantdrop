import { readFileSync } from 'node:fs';
import { atomicJson } from '../auth/atomic-json.js';

export function createDiskCache(path) {
  const entries=new Map();
  // Credentials and web sessions stay in memory; old snapshots are filtered on load too.
  const persistable=url=>!/^https:\/\/deviantdrop\.cache\.internal\/(?:da|api)\//.test(url);
  try {for(const [key,value] of Object.entries(JSON.parse(readFileSync(path,'utf8')))) if(persistable(key)&&value?.expires>Date.now())entries.set(key,value);} catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  let timer;
  const flush=()=>{
    clearTimeout(timer);timer=null;
    for(const [key,value] of entries) if(value.expires<=Date.now()) entries.delete(key);
    atomicJson(path,Object.fromEntries([...entries].filter(([key])=>persistable(key))));
  };
  return {
    flush,
    async match(input) {const hit=entries.get(String(input));return hit?.expires>Date.now()?new Response(hit.body,{headers:hit.headers}):undefined;},
    async put(input,response) {
      const ttl=Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1]||0);
      entries.set(String(input),{body:await response.text(),headers:Object.fromEntries(response.headers),expires:Date.now()+ttl*1000});
      if(!timer) timer=setTimeout(()=>{try{flush();}catch{console.error('缓存持久化失败');}},500).unref();
    },
  };
}
