import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewService,fetchPublicMedia} from '../src/preview/server.js';

test('preview metadata caches anonymous oembed and escapes HTML; image URL is public', async()=>{
  const data=new Map();let calls=0;
  const preview=new PreviewService({baseUrl:'https://bot.example',cacheGet:async(ns,k)=>data.get(k),cacheSet:async(ns,k,v)=>data.set(k,v),fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.headers?.Cookie,undefined);
    return Response.json({title:'<script>x</script>',author_name:'author',thumbnail_url:'https://images.wixmp.com/public.jpg'});
  }});
  await preview.remember({id:'123',title:'old',sourceUrl:'https://www.deviantart.com/a/art/b-123',url:'https://images.wixmp.com/private.jpg?token=secret'});
  const r=await preview.handle(new Request('https://bot.example/d/123'));
  const html=await r.text();assert.match(html,/og:image/);assert.match(html,/https:\/\/bot.example\/d\/123\/image/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/private.jpg|token=secret/);
  await preview.handle(new Request('https://bot.example/d/123'));assert.equal(calls,1);
});
test('media proxy blocks unsafe initial URLs and redirects before contacting destination',async()=>{
  let calls=0;
  await assert.rejects(fetchPublicMedia('http://127.0.0.1/'));
  await assert.rejects(fetchPublicMedia('https://images.wixmp.com/a',{},async(url)=>{calls++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/admin'}});}));
  assert.equal(calls,1);
  await assert.rejects(fetchPublicMedia('https://images.wixmp.com.evil.example/a'));
});
