# 发布编排（ReleaseGraph）

本仓库的版本号、tag、GitHub Release 由 [redtidev1918/releasegraph](https://github.com/redtidev1918/releasegraph) 的复用工作流编排；release-please 只负责 conventional commits、CHANGELOG、版本与 Release PR。

## 当前接入（已核实，2026-09-10）

| 项 | 值 |
| --- | --- |
| 调用方 | `.github/workflows/release.yml` → `redtidev1918/releasegraph/.github/workflows/reusable-release.yml@v1` |
| 引擎版本 | `v1` 稳定别名随引擎发布前移；2026-09-10 已到 `v1.4.0`（commit `79e35db`） |
| 发布契约 | `.release-policy.yml`（v1 格式：`versioning.mode`） |
| release-please | `release-please-config.json` 设 `skip-github-release: true`，manifest `.release-please-manifest.json` |
| 传参 | `version` / `dry_run` / `force` / `repair` / `stage`，与 `workflow_call` 输入一一对应 |
| 调用方权限 | `contents: write`、`pull-requests: write`、`packages: write`、`issues: write`、`id-token: write` |
| 健康度 | fleet 面板：`managed`、desired `1.6.3`、latest `v1.6.3`、`HEALTHY` |

Release 资产里出现的 `RELEASE-METADATA.json` 由引擎自己写入，不属于 `assets.required` 契约（本仓库 `assets.required` 为空，`kind: none`）。

### 引擎升级记录（消费方必须跟的部分）

| 引擎版本 | 消费方影响 | 处理 |
| --- | --- | --- |
| `v1.4.0`（2026-09-10，Version Provider Reconciliation Layer） | 复用工作流有两个 job 新增 `issues: write`（provider 复核）。调用方未授予该权限时，**整个 Release 运行直接 `startup_failure`，连 job 都不会创建** | 已在 `.github/workflows/release.yml` 的 `permissions` 补上 `issues: write` |

排查方法：Release 出现 `startup_failure` 时先对比 `permissions` 与复用工作流各 job 的权限集合：

```bash
gh api repos/redtidev1918/releasegraph/contents/.github/workflows/reusable-release.yml --jq '.content' | base64 -d \
  | grep -E '^\s+(contents|pull-requests|packages|issues|id-token):'
```

同账户其他受管仓库也踩到了同一个坑，2026-09-10 已统一补齐 `issues: write`（各仓库 Release 运行随即恢复 `success`）：

`dakit`、`daviewer`、`deviantart-downloader`、`graf`、`ludum`、`NekoTime`、`paranote`、`pixiv-token-getter`、`pixivflow-telepost-deploy`、`pixivflow-webui`、`TelePost`、`telepress`（`PixivFlow` 本来就有该权限；`releasegraph` 自己走 `infra-release.yml`，不受影响）。

升级引擎时的通用做法：引擎发布新 minor 后先看复用工作流各 job 的权限集合，把调用方 `permissions` 一次性对齐，再跑一次 Release 确认不再是 `startup_failure`。

## 下一代协议：暂不可用，等引擎发布后再切

`releasegraph` 的 README / `docs/quick-start.md` 已按新协议书写（YAML + `apiVersion` + `versioning.provider` + `metadata`）：

```yaml
apiVersion: releasegraph.dev/v1
kind: none
versioning: {provider: release-please}
assets: {required: []}
registries: {github: {required: true}}
checksums: false
metadata: true
```

但**目前引擎还不接受它**：`schemas/release-policy.schema.json` 在 `v1` 与 `main` 上完全相同 —— 仍然是 `versioning.mode`、`additionalProperties: false`，且属性表里根本没有 `apiVersion` 与 `metadata`。现在照抄 README 示例会让 `.release-policy.yml` 校验失败。所以本仓库保持 v1 格式，等引擎发布新 schema 后再切。

## 就绪检查（切换前跑一次）

```bash
# 1) 新 schema 是否已经支持新字段
gh api repos/redtidev1918/releasegraph/contents/schemas/release-policy.schema.json --jq '.content' | base64 -d \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); p=s["properties"]; print("apiVersion:", "apiVersion" in p, "| metadata:", "metadata" in p, "| versioning.required:", p["versioning"].get("required"))'

# 2) 引擎是否有更新的发布
gh release list -R redtidev1918/releasegraph --limit 3
```

判定：出现 `apiVersion: True`（且 `versioning.required` 含 `provider`）说明新协议已进 schema，可以切换；只看到 README 变化而 schema 未变，说明文档仍领先实现，继续等。

## 切换清单（就绪后执行）

1. 按新 schema 改写 `.release-policy.yml`（字段与语法以 schema 为准，不要只照抄 README）。
2. 本地校验：`releasegraph inspect --path .release-policy.yml`（或按需 `--output json`）。
3. 手动跑一次 `Release` workflow，`dry_run=true`，确认计划与资产契约通过。
4. 合并 release PR，观察正式发布、tag 与 fleet 面板恢复 `HEALTHY`。
5. 若新引擎同时改变了 caller 输入或 secrets 名称，同步更新 `.github/workflows/release.yml`。
6. 任何一步失败即回退到 v1 格式并把失败原因记录在本文件。
