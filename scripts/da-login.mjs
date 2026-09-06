#!/usr/bin/env node
// Local development helper. Production uses /login; this never deploys or prints tokens.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/auth/credential-store.js';
import { Agent, ProxyAgent } from 'undici';
import { createProxyFetch } from '../src/network.js';
const [clientId=process.env.CLIENT_ID,clientSecret=process.env.CLIENT_SECRET,portArg='8787']=process.argv.slice(2);
if(!clientId)throw new Error('用法: CLIENT_ID=... CLIENT_SECRET=... npm run login');
const port=Number(portArg);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
const redirectUri=`http://127.0.0.1:${port}/callback`;
const state=randomBytes(32).toString('base64url');
const verifier=randomBytes(48).toString('base64url');
const url=new URL('https://www.deviantart.com/oauth2/authorize');
url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:'basic browse',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
const proxy=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
if(proxy)globalThis.fetch=createProxyFetch(new ProxyAgent(proxy),new Agent());
const store=new CredentialStore({path:join(process.env.AUTH_DIR||join(homedir(),'.config','deviantdrop','auth'),'deviantart.json')});
let consumed=false;
const server=createServer(async(req,res)=>{
  const query=new URL(req.url,redirectUri);
  if(query.pathname!=='/callback'){res.writeHead(404).end();return;}
  if(consumed||query.searchParams.get('state')!==state){res.writeHead(400).end('Invalid state');return;}
  consumed=true;
  try{
    const code=query.searchParams.get('code');
    if(!code||query.searchParams.has('error'))throw new Error('Authorization denied');
    const body=new URLSearchParams({grant_type:'authorization_code',code,client_id:clientId,redirect_uri:redirectUri,code_verifier:verifier});
    if(clientSecret)body.set('client_secret',clientSecret);
    const response=await fetch('https://www.deviantart.com/oauth2/token',{method:'POST',body,signal:AbortSignal.timeout(20000)});
    const data=await response.json();
    if(!response.ok||!data.refresh_token)throw new Error('Token exchange failed');
    store.save(data.refresh_token);
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('已保存本地凭据，可以关闭本页。生产环境请使用 Bot 的 /login。');
    console.log(`凭据已保存到 ${store.path}（未部署）。`);
  }catch{res.writeHead(500).end('Login failed');}
  finally{server.close();clearTimeout(timeout);}
});
const timeout=setTimeout(()=>{server.close();process.exitCode=1;},10*60*1000);
server.listen(port,'127.0.0.1',()=>console.log(`在浏览器打开：\n${url.href}`));
