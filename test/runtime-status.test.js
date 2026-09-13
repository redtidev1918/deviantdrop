// 生产故障回归：DeviantDrop 曾在 VPS 上无限重启（exit 1 + restart 策略），
// 期间 /health 恒返回 {ok:true}，任何监控都看不出服务完全不能收发消息。
//
// 这组测试固化四件事：
//   1. Telegram 入口 401 不再让进程退出（崩溃循环）；
//   2. 入口链路与 DeviantArt 抓取是两个故障域，/start 不依赖 DA 登录；
//   3. /health 反映真实能力，能定位到具体故障域；
//   4. 日志里永远不出现 bot token（也顺带证明 poll 模式会摘掉残留 webhook）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {event, healthPayload, redact, resetForTest, setComponent, bump} from '../src/runtime/status.js';

// 形状合法但完全虚构的 token：只用于断言它绝不出现在日志里。
const FAKE_TOKEN='1234567890:AAFakeTokenForRegressionTests_ONLY_abcdefghi';

function startBot(preloadSource, extraEnv={}){
  const dir=mkdtempSync(join(tmpdir(),'dd-status-'));
  const child=spawn(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(preloadSource)}`,'src/main.js'],{
    cwd:new URL('..',import.meta.url),
    env:{...process.env,MODE:'poll',PORT:'0',HTTP_HOST:'127.0.0.1',
      AUTH_DIR:dir,CACHE_FILE:join(dir,'cache.json'),
      BOT_TOKEN:FAKE_TOKEN,WEBHOOK_SECRET:'regression-webhook-secret',
      HTTP_PROXY:'',HTTPS_PROXY:'',PUBLIC_BASE_URL:'',DA_REFRESH_TOKEN:'',DA_COOKIES:'',
      ...extraEnv},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  const ready=new Promise((resolve,reject)=>{
    child.stdout.on('data',(b)=>{output+=b;const m=output.match(/127\.0\.0\.1:(\d+) \(mode=poll\)/);if(m)resolve(m[1]);});
    child.stderr.on('data',(b)=>{output+=b;});
    child.once('exit',()=>reject(new Error('进程在 /health 可用前退出（这正是崩溃循环症状）')));
  });
  return {child,ready,env:extraEnv,get output(){return output;}};
}

test('redact strips token shapes and secret-named fields',()=>{
  const payload=redact({
    BOT_TOKEN:FAKE_TOKEN,
    note:`url https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`,
    cookie:'session=abc',
    nested:{refresh_token:'xyz',keep:'visible'},
    update_id:7,
  });
  const text=JSON.stringify(payload);
  assert.doesNotMatch(text,/1234567890:/);
  assert.doesNotMatch(text,/AAFakeTokenForRegressionTests/);
  assert.equal(payload.BOT_TOKEN,'[redacted]');
  assert.equal(payload.cookie,'[redacted]');
  assert.equal(payload.nested.refresh_token,'[redacted]');
  assert.equal(payload.nested.keep,'visible');
  assert.equal(payload.update_id,7);
});

test('healthPayload reports degraded only for critical components',()=>{
  resetForTest();
  setComponent('http_server',{state:'listening',ok:true,critical:true});
  setComponent('telegram_ingress',{state:'polling',ok:true,critical:true});
  // DeviantArt 是非关键域：登录失效绝不能让整个 Bot 看起来 down。
  setComponent('deviantart_auth',{state:'expired',ok:false,critical:false});
  let payload=healthPayload({service:'deviantdrop'});
  assert.equal(payload.ok,true);
  assert.equal(payload.status,'ok');
  assert.deepEqual(payload.degraded,[]);

  resetForTest();
  setComponent('http_server',{state:'listening',ok:true,critical:true});
  setComponent('telegram_ingress',{state:'unauthorized',ok:false,critical:true,detail:'Unauthorized'});
  setComponent('deviantart_auth',{state:'ok',ok:true,critical:false});
  payload=healthPayload({service:'deviantdrop'});
  assert.equal(payload.ok,false);
  assert.equal(payload.status,'degraded');
  assert.deepEqual(payload.degraded,['telegram_ingress']);
});

test('health is not ok before the ingress is proven',()=>{
  resetForTest();
  setComponent('http_server',{state:'listening',ok:true,critical:true});
  setComponent('telegram_ingress',{state:'starting',ok:false,critical:true});
  assert.equal(healthPayload().status,'degraded');
});

test('event never emits a token and keeps a bounded recent ring',()=>{
  resetForTest();
  event('tg_send_started',{method:'sendMessage',url:`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`});
  const payload=healthPayload();
  const text=JSON.stringify(payload);
  assert.doesNotMatch(text,/AAFakeTokenForRegressionTests/);
  assert.equal(payload.recent_events.at(-1).event,'tg_send_started');
  for(let i=0;i<200;i+=1)event('noise',{i});
  assert.ok(healthPayload().recent_events.length<=40);
});

test('revoked BOT_TOKEN keeps the process alive and reports degraded instead of crash-looping',{timeout:30000},async t=>{
  const preload=`
    globalThis.fetch=async(url)=>{
      const u=String(url);
      if(u.includes('/getWebhookInfo'))return Response.json({ok:true,result:{url:'https://stale.example.test/webhook/bot1',pending_update_count:0}});
      if(u.includes('/deleteWebhook'))return Response.json({ok:true,result:true});
      if(u.includes('/getUpdates'))return Response.json({ok:false,error_code:401,description:'Unauthorized'},{status:401});
      return Response.json({ok:true,result:{message_id:1}});
    };`;
  const bot=startBot(preload);
  t.after(()=>bot.child.kill('SIGKILL'));
  const port=await bot.ready;

  const health=await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status,200);
  const body=await health.json();
  await new Promise((r)=>setTimeout(r,1500));

  // 关键断言 1：进程还活着（修复前这里是 exit(1) → restart 循环）。
  assert.equal(bot.child.exitCode,null);
  // 关键断言 2：/health 说真话。
  assert.equal(body.status,'degraded');
  assert.ok(body.degraded.includes('telegram_ingress'));
  assert.equal(body.components.telegram_ingress.state,'unauthorized');
  assert.equal(body.components.http_server.ok,true);
  // 关键断言 3：故障可观察，且有可执行的提示。
  const second=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.ok(second.counters.telegram_unauthorized>=1);
  assert.match(bot.output,/"event":"telegram_ingress_unauthorized"/);
  // 关键断言 4：poll 模式必须摘掉残留 webhook（否则 getUpdates 会 409）。
  assert.match(bot.output,/"event":"telegram_webhook_state"/);
  assert.match(bot.output,/"event":"telegram_webhook_cleared"/);
  // 关键断言 5：token 绝不进日志。
  assert.doesNotMatch(bot.output,/AAFakeTokenForRegressionTests/);
  assert.doesNotMatch(bot.output,/1234567890:/);

  const exit=once(bot.child,'exit');
  bot.child.kill('SIGTERM');
  await exit;
});

test('/start replies without touching DeviantArt',{timeout:30000},async t=>{
  const preload=`
    let served=false;
    globalThis.fetch=async(url)=>{
      const u=String(url);
      if(u.includes('/getWebhookInfo'))return Response.json({ok:true,result:{url:'',pending_update_count:0}});
      if(u.includes('/getUpdates')){
        if(!served){served=true;return Response.json({ok:true,result:[{update_id:42,message:{message_id:7,date:0,chat:{id:555,type:'private'},from:{id:555},text:'/start'}}]});}
        return Response.json({ok:true,result:[]});
      }
      return Response.json({ok:true,result:{message_id:100}});
    };`;
  const bot=startBot(preload);
  t.after(()=>bot.child.kill('SIGKILL'));
  const port=await bot.ready;

  const deadline=Date.now()+8000;
  while(Date.now()<deadline&&!bot.output.includes('"event":"update_accepted"'))await new Promise((r)=>setTimeout(r,100));

  assert.match(bot.output,/"event":"update_received"/,'必须记录 update 到达入口');
  assert.match(bot.output,/"event":"update_accepted"/);
  assert.match(bot.output,/"event":"tg_send_ok"/);
  assert.match(bot.output,/"method":"sendMessage"/);
  // /start 是纯命令路径：DeviantArt 抓取与登录状态不得参与，否则一次 DA 故障就会
  // 让「Bot 完全不回复」。
  assert.doesNotMatch(bot.output,/"event":"da_fetch_started"/);
  assert.doesNotMatch(bot.output,/AAFakeTokenForRegressionTests/);

  const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.status,'ok');
  assert.equal(health.components.telegram_ingress.state,'polling');
  assert.equal(health.counters.updates_received,1);
  assert.equal(health.counters.updates_accepted,1);
  assert.equal(health.counters.tg_sends_ok>=1,true);
  assert.doesNotMatch(JSON.stringify(health),/AAFakeTokenForRegressionTests/);
});

test('plain non-link text is rejected as no_links and still answered',{timeout:30000},async t=>{
  const preload=`
    let served=false;
    globalThis.fetch=async(url)=>{
      const u=String(url);
      if(u.includes('/getWebhookInfo'))return Response.json({ok:true,result:{url:'',pending_update_count:0}});
      if(u.includes('/getUpdates')){
        if(!served){served=true;return Response.json({ok:true,result:[{update_id:99,message:{message_id:8,date:0,chat:{id:556,type:'private'},from:{id:556},text:'hello there'}}]});}
        return Response.json({ok:true,result:[]});
      }
      return Response.json({ok:true,result:{message_id:101}});
    };`;
  const bot=startBot(preload);
  t.after(()=>bot.child.kill('SIGKILL'));
  await bot.ready;
  const deadline=Date.now()+8000;
  while(Date.now()<deadline&&!bot.output.includes('"event":"update_rejected"'))await new Promise((r)=>setTimeout(r,100));
  assert.match(bot.output,/"event":"update_rejected","ts":"[^"]+","update_id":99,"reason":"no_links"/);
  assert.match(bot.output,/"event":"tg_send_ok"/);
  assert.doesNotMatch(bot.output,/"event":"da_fetch_started"/);
});
