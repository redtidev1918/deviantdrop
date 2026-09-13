#!/usr/bin/env node
// 运行时 secret 的写入端：让「换 Telegram bot token」不再等于「改 .env + 重建容器」。
//
// 事故（2026-09-12）：BotFather 吊销 token 后，恢复手段只有 `docker compose up -d
// --force-recreate`。本脚本只做一件事——把新 token 原子写进运行时 secret 文件
// （0600，目录 0700），运行中的服务会在 1~2 秒内发现、getMe 验证、然后只重建
// Telegram 入口。进程、HTTP server、DeviantArt 认证、cache、preview、OAuth 全都不动。
//
// 用法（容器内或能写到 BOT_TOKEN_FILE 的地方）：
//   node scripts/dd-token.mjs set telegram     # 隐藏输入，写前先验证
//   node scripts/dd-token.mjs status           # 只读：当前来源/状态（不打印 secret）
//
// 注意：这里的前置验证只是「提前告诉用户 token 不对」，正确性不押在它身上——
// 服务自己的 RuntimeSecretStore 仍然会再验证一次，只有明确有效才切换。
//
// 依赖：仅 node 内置模块。

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr, argv, env, exit } from 'node:process';
import {
  DEFAULT_TELEGRAM_TOKEN_PATH, SECRET_FILE_MODE, readSecretFile, writeSecretFile,
} from '../src/runtime/secrets.js';
import { TOKEN_VALIDATION, tokenShapeOk, validateBotToken } from '../src/telegram/ingress.js';

const SECRET_PATH = env.BOT_TOKEN_FILE || DEFAULT_TELEGRAM_TOKEN_PATH;
const HEALTH_URL = env.DD_HEALTH_URL || `http://127.0.0.1:${env.PORT || 8080}/health`;

function usage() {
  stdout.write(`用法：
  node scripts/dd-token.mjs set telegram     写入 Telegram bot token（隐藏输入、原子落盘）
  node scripts/dd-token.mjs status           打印运行时 secret 的来源与状态（不含 secret）

可用环境变量：
  BOT_TOKEN_FILE   运行时 secret 路径（默认 ${DEFAULT_TELEGRAM_TOKEN_PATH}）
  DD_HEALTH_URL    /health 地址（默认 ${HEALTH_URL}）
`);
}

/** 隐藏输入：不回显、不进 shell history、不落任何临时文件。 */
async function promptHidden(label) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const original = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (text) => {
    // 只回显提示语本身，其余（包括换行）一律吞掉。
    if (text.includes(label)) stdout.write(label);
  };
  try {
    const answer = await rl.question(label);
    stdout.write('\n');
    return answer;
  } finally {
    if (original) rl._writeToOutput = original;
    rl.close();
  }
}

async function readToken() {
  // 支持管道输入（CI / 脚本），但绝不当成命令行参数——argv 会进 ps 与 history。
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const first = (await promptHidden('New Telegram bot token: ')).trim();
  if (!first) return '';
  const again = (await promptHidden('Confirm token: ')).trim();
  if (first !== again) {
    stderr.write('两次输入不一致，未写入。\n');
    return null;
  }
  return first;
}

async function commandStatus() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    const secret = body?.runtime_secrets?.telegram_bot_token;
    stdout.write(`服务状态：${body?.status ?? 'unknown'}（HTTP ${response.status}）\n`);
    if (!secret) {
      stdout.write('运行中的服务没有报告 runtime_secrets（可能还是旧版本）。\n');
    } else {
      stdout.write(`  来源 source          : ${secret.source}\n`);
      stdout.write(`  可热更新 reloadable  : ${secret.reloadable}\n`);
      stdout.write(`  状态 state           : ${secret.state}\n`);
      stdout.write(`  最近验证 last_validation: ${secret.last_validation ?? '(未验证)'}\n`);
      stdout.write(`  最近切换 last_reload : ${secret.last_reload ?? '(本次启动未切换)'}\n`);
      stdout.write(`  Bot                  : ${secret.bot_username ?? '(未知)'} ${secret.bot_id ? `id=${secret.bot_id}` : ''}\n`);
      if (secret.last_reason) stdout.write(`  最近原因 last_reason : ${secret.last_reason}\n`);
    }
    const degraded = body?.degraded ?? [];
    if (degraded.length) stdout.write(`degraded: ${degraded.join(', ')}\n`);
    stdout.write(`本地 secret 文件：${SECRET_PATH}${readSecretFile(SECRET_PATH) ? '（存在）' : '（不存在）'}\n`);
    return 0;
  } catch (error) {
    stderr.write(`读不到 ${HEALTH_URL}：${error?.cause?.code || error?.name || error}\n`);
    stdout.write(`本地 secret 文件：${SECRET_PATH}${readSecretFile(SECRET_PATH) ? '（存在）' : '（不存在）'}\n`);
    return 1;
  }
}

async function commandSet() {
  const token = await readToken();
  if (token === null) return 1;
  if (!token) {
    stderr.write('没有读到 token，未写入。\n');
    return 1;
  }
  if (!tokenShapeOk(token)) {
    // 只报形状，不回显任何片段。
    stderr.write('token 形状不合法（应为 <bot_id>:<secret>，且不含空白）。未写入。\n');
    return 1;
  }

  stdout.write('正在用 getMe 预验证（可选，服务仍会自行复核）…\n');
  const result = await validateBotToken(token);
  if (result.status === TOKEN_VALIDATION.INVALID) {
    stderr.write(`token 被 Telegram 拒绝，未写入（HTTP ${result.httpStatus ?? '-'}）。\n`);
    return 1;
  }
  if (result.status === TOKEN_VALIDATION.DEFERRED) {
    // 网络问题不代表 token 错：仍然写入，由服务在恢复后退避重试并自行验证。
    stdout.write(`暂时无法验证（${result.reason}）：仍然写入，服务会在验证成功后切换。\n`);
  } else {
    stdout.write(`验证通过：${result.botUsername ? `@${result.botUsername}` : '该 Bot'}${result.botId ? `（id=${result.botId}）` : ''}\n`);
  }

  try {
    writeSecretFile(SECRET_PATH, token);
  } catch (error) {
    // 权限/路径问题必须给可执行的信息，而不是把堆栈甩给用户。
    stderr.write(`写入 ${SECRET_PATH} 失败：${error?.code || error?.name || error}\n`);
    stderr.write('请确认该目录存在且当前用户可写（容器内默认 /data/secrets，属主为运行用户 node）。\n');
    return 1;
  }
  stdout.write(`已原子写入 ${SECRET_PATH}（mode 0${SECRET_FILE_MODE.toString(8)}）。\n`);
  stdout.write('服务会在 1~2 秒内自行发现、验证并只重建 Telegram 入口——不需要重启容器。\n');
  stdout.write(`用 \`curl -s ${HEALTH_URL}\` 观察 status 从 degraded 变 ok。\n`);
  return 0;
}

async function main() {
  const [scope, subject] = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (!scope || scope === 'help' || scope === '--help') { usage(); return scope ? 0 : 1; }
  if (scope === 'status') return commandStatus();
  if (scope === 'set') {
    if (subject && subject !== 'telegram') {
      stderr.write(`暂不支持 set ${subject}：目前只有 telegram bot token 支持热更新。\n`);
      return 1;
    }
    return commandSet();
  }
  usage();
  return 1;
}

exit(await main());
