import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 下一代 ReleaseGraph 协议（apiVersion / versioning.provider / metadata）目前连引擎自己的
// schema 都还不接受（见 docs/RELEASEGRAPH.md）。这条断言把「先别切」这个决定固定下来：
// 真正切换时必须同时更新该文档与本测试，避免误把 README 示例粘进契约文件。
test('.release-policy.yml 仍是引擎当前支持的 v1 契约格式', () => {
  const policy = JSON.parse(readFileSync(new URL('../.release-policy.yml', import.meta.url), 'utf8'));

  for (const key of ['kind', 'versioning', 'assets', 'registries']) {
    assert.ok(key in policy, `契约缺少必填字段 ${key}`);
  }
  assert.equal(policy.versioning.mode, 'release-please');
  assert.ok(Array.isArray(policy.assets.required), 'assets.required 必须是数组');
  assert.equal(policy.registries.github?.required, true);
  assert.equal('apiVersion' in policy, false, 'apiVersion 属于未发布的下一代协议；切换前先更新 docs/RELEASEGRAPH.md');
  assert.equal('metadata' in policy, false, 'metadata 字段尚未进入引擎 schema；切换前先更新 docs/RELEASEGRAPH.md');
});
