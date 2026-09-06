import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createDiskCache} from '../src/storage/cache.js';

test('persistent cache excludes credentials and retains file IDs after restart',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'dd-cache-')),'cache.json');const cache=createDiskCache(path);
 for(const ns of ['da','api','fid'])await cache.put(`https://deviantdrop.cache.internal/${ns}/x`,new Response(JSON.stringify({token:ns}),{headers:{'Cache-Control':'max-age=300'}}));
 cache.flush();const raw=readFileSync(path,'utf8');assert.doesNotMatch(raw,/internal\/(da|api)\//);
 const next=createDiskCache(path);assert.ok(await next.match('https://deviantdrop.cache.internal/fid/x'));
});
test('poll process also serves HTTP health without external requests',{timeout:10000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'dd-runtime-'));
 const preload='globalThis.fetch=async()=>Response.json({ok:true,result:[]});';
 const child=spawn(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(preload)}`,'src/main.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,MODE:'poll',PORT:'0',HTTP_HOST:'127.0.0.1',AUTH_DIR:dir,CACHE_FILE:join(dir,'cache.json'),BOT_TOKEN:'test:secret',WEBHOOK_SECRET:'secret',HTTP_PROXY:'',HTTPS_PROXY:'',PUBLIC_BASE_URL:'',DA_REFRESH_TOKEN:'',DA_COOKIES:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGTERM'));
 let output='';const ready=new Promise((resolve,reject)=>{child.stdout.on('data',b=>{output+=b;const m=output.match(/127\.0\.0\.1:(\d+) \(mode=poll\)/);if(m)resolve(m[1]);});child.once('exit',()=>reject(new Error('Exited before health')));});
 const port=await ready;const r=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(r.status,200);
 const exit=once(child,'exit');child.kill('SIGTERM');await exit;
});
