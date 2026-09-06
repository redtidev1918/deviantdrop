import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/auth/credential-store.js';
import { CookieStore } from '../src/auth/cookie-store.js';
import { getOfficialToken } from '../src/auth/token.js';
import { OAuthLoginFlow } from '../src/auth/oauth-login.js';
import { createAuthRequestHandler } from '../src/auth/http-auth.js';
const path = () => join(mkdtempSync(join(tmpdir(), 'dd-regression-')), 'auth.json');

test('corrupt credentials never restore env seed, failed writes throw', () => {
  const file = path(); writeFileSync(file, '{broken');
  const store = new CredentialStore({path:file,seedEnvToken:'stale'});
  assert.equal(store.getRefreshToken(),null); assert.equal(store.isInvalid(),true);
  const blocked = path(); writeFileSync(blocked,'not a directory');
  assert.throws(()=>new CredentialStore({path:join(blocked,'child')}).save('new'));
});
test('CookieStore reads external atomic updates and secure permissions', () => {
  const file=path(); const a=new CookieStore({path:file,seedEnvCookie:'auth=one'});
  assert.equal(a.getCookies(),'auth=one');
  new CookieStore({path:file}).set('auth=two');
  assert.equal(a.getCookies(),'auth=two'); assert.equal(statSync(file).mode&0o777,0o600);
});
test('concurrent refresh exchanges once, rotates to disk; invalid_grant clears seed permanently', async t => {
  const store=new CredentialStore({path:path(),seedEnvToken:'old'}); store.load();
  const env={credentialStore:store,CLIENT_ID:'id',CLIENT_SECRET:'secret',DA_REFRESH_TOKEN:'stale'};
  const original=globalThis.fetch; t.after(()=>globalThis.fetch=original);
  let requests=0;
  globalThis.fetch=async (url,init)=>{
    requests++; assert.equal(new URL(url).search,'');
    assert.equal(new URLSearchParams(init.body).get('refresh_token'),'old');
    await new Promise(r=>setTimeout(r,5));
    return Response.json({access_token:'access',refresh_token:'rotated',expires_in:3600});
  };
  assert.deepEqual(await Promise.all([getOfficialToken(env),getOfficialToken(env)]),['access','access']);
  assert.equal(requests,1); assert.equal(new CredentialStore({path:store.path}).getRefreshToken(),'rotated');
  const next={...env,credentialStore:new CredentialStore({path:store.path})};
  globalThis.fetch=async ()=>Response.json({error:'invalid_grant'},{status:400});
  await assert.rejects(getOfficialToken(next),{name:'AuthRevokedError'});
  assert.equal(next.credentialStore.getRefreshToken(),null);
  globalThis.fetch=async (url,init)=>{
    assert.equal(new URLSearchParams(init.body).get('grant_type'),'client_credentials');
    return Response.json({access_token:'public',expires_in:3600});
  };
  assert.equal(await getOfficialToken(next),'public');
  assert.equal(JSON.parse(readFileSync(store.path)).refreshToken,null);
});
test('cookie form token is purpose-bound, origin checked, one-time and hot', async () => {
  const cookies=new CookieStore({path:path()});
  const flow=new OAuthLoginFlow({clientId:'id',redirectUri:'https://bot.example/auth/deviantart/callback',credentialStore:new CredentialStore({path:path()})});
  const handler=createAuthRequestHandler(flow,cookies);
  const oauth=flow.issueLoginToken();
  assert.equal((await handler(new Request(`https://bot.example/auth/deviantart/cookies?t=${oauth}`))).status,400);
  const response=await handler(new Request(`https://bot.example/auth/deviantart/cookies?t=${flow.issueLoginToken('cookies')}`));
  const token=(await response.text()).match(/name="t" value="([^"]+)"/)[1];
  const request=(origin)=>new Request('https://bot.example/auth/deviantart/cookies',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({t:token,cookies:'auth=hot'})});
  assert.equal((await handler(request('https://evil.example'))).status,403);
  assert.equal((await handler(request('https://bot.example'))).status,200);
  assert.equal(cookies.getCookies(),'auth=hot');
  assert.equal((await handler(request('https://bot.example'))).status,400);
});
test('OAuth expired state and failed credential save cannot report success', async t => {
  const original=globalThis.fetch; t.after(()=>globalThis.fetch=original);
  const flow=new OAuthLoginFlow({clientId:'id',redirectUri:'https://bot.example/auth/deviantart/callback',credentialStore:{save(){throw new Error('disk full');}}});
  const state=new URL(flow.start(flow.issueLoginToken())).searchParams.get('state');
  flow.states.get(state).createdAt=Date.now()-11*60*1000;
  await assert.rejects(flow.callback({code:'code',state}),/过期/);
  const state2=new URL(flow.start(flow.issueLoginToken())).searchParams.get('state');
  globalThis.fetch=async()=>Response.json({refresh_token:'new'});
  await assert.rejects(flow.callback({code:'code',state:state2}),/disk full/);
});
