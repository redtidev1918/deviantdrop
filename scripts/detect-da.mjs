#!/usr/bin/env node
// DA 放行检测：在【目标服务器】上运行，30 秒内告诉你这台机器能用哪条取数路径。
//
//   node scripts/detect-da.mjs [client_id client_secret]
// （带凭据可顺带测官方 API 数据面；不带则只测匿名网页路径）
//
// 判定：
//   - "官方 API 数据面可达" → 配置 CLIENT_ID/CLIENT_SECRET 后部署（推荐）；
//   - "只有匿名网页可达" → 不配凭据直接部署（网页路径）；
//   - 两条都不通 → 这台机器的出口被 DeviantArt 封锁，换一台（如住宅网络/别的 VPS）。
const SAMPLE_PAGE = "https://www.deviantart.com/loish/art/underwater-913624585";
const SAMPLE_ID = "913624585";
const SAMPLE_USER = "loish";
const SAMPLE_UUID = "4141C2B4-BCA1-2A3E-7241-3FCFB091BA69";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function status(url, init = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", ...init });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch (error) {
    return `ERR ${error.cause?.code || error.message}`;
  }
}

async function main() {
  const [clientId, clientSecret] = process.argv.slice(2);
  console.log("== DeviantArt 出口检测 ==");

  // 1) 匿名网页路径：首页拿 csrf 再调一次 init（dakit/deviantart-downloader 同款流程）
  const home = await status("https://www.deviantart.com/");
  let init = "skipped";
  if (home === 200) {
    try {
      const html = await (await fetch("https://www.deviantart.com/", {
        headers: { "User-Agent": UA, Accept: "text/html" },
      })).text();
      const csrf = html.match(/window\.__CSRF_TOKEN__ = '([^']+)'/)?.[1];
      if (csrf) {
        init = await status(
          `https://www.deviantart.com/_puppy/dadeviation/init?deviationid=${SAMPLE_ID}&username=${SAMPLE_USER}&type=art&include_session=false&csrf_token=${csrf}&mature_content=true`,
          { headers: { "User-Agent": UA, Accept: "application/json", Referer: SAMPLE_PAGE } },
        );
      } else {
        init = "no-csrf-in-page";
      }
    } catch (error) {
      init = `ERR ${error.message}`;
    }
  }
  console.log(`匿名网页: 首页=${home}  init=${init}  ${home === 200 && init === 200 ? "✅ 网页路径可用" : ""}`);

  // 2) 官方 API（需要 client_id/client_secret）
  if (clientId && clientSecret) {
    try {
      const tokenRes = await fetch(
        `https://www.deviantart.com/oauth2/token?grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
        { method: "POST", headers: { "User-Agent": UA } },
      );
      const token = (await tokenRes.json()).access_token;
      if (token) {
        const deviation = await status(
          `https://www.deviantart.com/api/v1/oauth2/deviation/${SAMPLE_UUID}?mature_content=true`,
          { headers: { Authorization: `Bearer ${token}`, "User-Agent": UA, "dA-minor-version": "20240701" } },
        );
        console.log(`官方 API: token=${tokenRes.status}  deviation=${deviation}  ${deviation === 200 ? "✅ 官方 API 路径可用（推荐）" : "❌ API 数据面被拦"}`);
      } else {
        console.log(`官方 API: token=${tokenRes.status}（凭据可能无效）`);
      }
    } catch (error) {
      console.log(`官方 API: ERR ${error.message}`);
    }
  } else {
    console.log("官方 API: 未提供 client_id/client_secret，跳过（可带参数重跑检测）");
  }
}

main();
