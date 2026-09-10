const TELEGRAM_API = 'https://api.telegram.org';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramBackoffSeconds(status, result, attempt) {
  const retryAfter = Number(result?.parameters?.retry_after);
  if (status === 429 && retryAfter > 0) return Math.min(retryAfter, 60);
  if (/flood|retry after|too many/i.test(String(result?.description || ''))) return Math.min(2 ** attempt, 60);
  return null;
}

export async function telegram(env, method, body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

    } catch {
      if (attempt < 3) {
        console.error(new Date().toISOString(), '[tg]', `${method} 网络错误，重试 ${attempt + 1}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error('Telegram 连接失败或超时，请稍后再试');
    }
    const result = await response.json().catch(() => null);
    const backoff = telegramBackoffSeconds(response.status, result, attempt);
    if (backoff !== null) {
      console.error(new Date().toISOString(), '[tg]', `${method} 限流，${backoff}s 后重试 ${attempt + 1}`);
      await sleep(backoff * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      const description = result?.description || `Telegram 返回 HTTP ${response.status}`;
      console.error(new Date().toISOString(), '[tg]', `${method} 失败: ${description}`);
      throw new Error(description);
    }
    return result.result;
  }
  throw new Error('Telegram 暂时限流，请稍后重试');
}

export async function telegramForm(env, method, formOrFactory) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const form = typeof formOrFactory === 'function' ? formOrFactory() : formOrFactory;
    let response;
    try {
      response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(180_000),
      });
    } catch {
      if (attempt < 2) {
        console.error(new Date().toISOString(), '[tg]', `${method} 网络错误，重试 ${attempt + 1}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error('Telegram 连接失败或超时，请稍后再试');
    }
    const result = await response.json().catch(() => null);
    const retryAfter = Number(result?.parameters?.retry_after);
    if (response.status === 429 && retryAfter > 0) {
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      const description = result?.description || `HTTP ${response.status}`;
      console.error(new Date().toISOString(), '[tg]', `${method} 失败: ${description}`);
      throw new Error(description);
    }
    return result.result;
  }
  throw new Error('Telegram 上传失败，请稍后重试');
}

export async function registerCommands(env, adminIds = []) {
  try {
    await telegram(env, 'setMyCommands', {
      commands: [
        { command: 'start', description: '开始使用' },
        { command: 'help', description: '查看用法' },
        { command: 'about', description: '项目与源码' },
      ],
    });
    for (const chatId of adminIds) {
      await telegram(env, 'setMyCommands', {
        scope: { type: 'chat', chat_id: Number(chatId) },
        commands: [
          { command: 'start', description: '开始使用' },
          { command: 'help', description: '查看用法' },
          { command: 'about', description: '项目与源码' },
          { command: 'login', description: '更新 DeviantArt 登录' },
          { command: 'cookie', description: '刷新网页会话 Cookie' },
          { command: 'status', description: '查看运行状态' },
        ],
      });
    }
  } catch (error) {
    console.warn(new Date().toISOString(), '[tg]', '注册 Bot 命令失败（不影响运行）:', error instanceof Error ? error.message : String(error));
  }
}
