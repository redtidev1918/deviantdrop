# Release orchestration (ReleaseGraph)

**Language / 语言:** [中文](/RELEASEGRAPH.md) · English

This repository's version numbers, tags and GitHub Releases are orchestrated by the reusable
workflow of [redtidev1918/releasegraph](https://github.com/redtidev1918/releasegraph);
release-please only handles conventional commits, the CHANGELOG, versioning and the release PR.

## Current integration (verified 2026-09-10)

| Item | Value |
| --- | --- |
| Caller | `.github/workflows/release.yml` → `redtidev1918/releasegraph/.github/workflows/reusable-release.yml@v1` |
| Engine version | The `v1` stable alias moves forward with engine releases; on 2026-09-10 it was `v1.4.0` (commit `79e35db`) |
| Release contract | `.release-policy.yml` (v1 format: `versioning.mode`) |
| release-please | `release-please-config.json` sets `skip-github-release: true`; manifest `.release-please-manifest.json` |
| Passed inputs | `version` / `dry_run` / `force` / `repair` / `stage`, matching the `workflow_call` inputs |
| Caller permissions | `contents: write`, `pull-requests: write`, `packages: write`, `issues: write`, `id-token: write` |
| Health | fleet panel: `managed`, desired `1.6.3`, latest `v1.6.3`, `HEALTHY` |

`RELEASE-METADATA.json` in the release assets is written by the engine itself and is not part of
the `assets.required` contract (this repository's `assets.required` is empty, `kind: none`).

### Engine upgrade log (the part consumers must follow)

| Engine version | Consumer impact | Action |
| --- | --- | --- |
| `v1.4.0` (2026-09-10, Version Provider Reconciliation Layer) | Two jobs in the reusable workflow gained `issues: write` (provider re-check). If the caller does not grant that permission, **the whole release run fails as `startup_failure` — no job is even created** | `issues: write` added to `permissions` in `.github/workflows/release.yml` |

Troubleshooting: when a release shows `startup_failure`, first compare `permissions` with the
permission set of each job in the reusable workflow:

```bash
gh api repos/redtidev1918/releasegraph/contents/.github/workflows/reusable-release.yml --jq '.content' | base64 -d \
  | grep -E '^\s+(contents|pull-requests|packages|issues|id-token):'
```

Other managed repositories on the same account hit the same trap; `issues: write` was added
everywhere on 2026-09-10 (and their release runs returned to `success`):

`dakit`, `daviewer`, `deviantart-downloader`, `graf`, `ludum`, `NekoTime`, `paranote`,
`pixiv-token-getter`, `pixivflow-telepost-deploy`, `pixivflow-webui`, `TelePost`, `telepress`
(`PixivFlow` already had the permission; `releasegraph` goes through `infra-release.yml` itself
and is unaffected).

The general practice when upgrading the engine: after a new engine minor is released, read the
permission set of each job in the reusable workflow, align the caller's `permissions` in one go,
then run a release once to confirm it is no longer a `startup_failure`.

## Next-generation protocol: not yet available, wait for the engine

The `releasegraph` README and `docs/quick-start.md` are written against the new protocol
(YAML + `apiVersion` + `versioning.provider` + `metadata`):

```yaml
apiVersion: releasegraph.dev/v1
kind: none
versioning: {provider: release-please}
assets: {required: []}
registries: {github: {required: true}}
checksums: false
metadata: true
```

But **the engine does not accept it yet**: `schemas/release-policy.schema.json` is identical on
`v1` and `main` — still `versioning.mode`, still `additionalProperties: false`, and the property
table has no `apiVersion` or `metadata` at all. Copying the README example today would make
`.release-policy.yml` fail validation. This repository therefore stays on the v1 format until the
engine ships the new schema.

## Readiness check (run once before switching)

```bash
# 1) does the new schema support the new fields yet
gh api repos/redtidev1918/releasegraph/contents/schemas/release-policy.schema.json --jq '.content' | base64 -d \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); p=s["properties"]; print("apiVersion:", "apiVersion" in p, "| metadata:", "metadata" in p, "| versioning.required:", p["versioning"].get("required"))'

# 2) is there a newer engine release
gh release list -R redtidev1918/releasegraph --limit 3
```

Verdict: seeing `apiVersion: True` (and `versioning.required` containing `provider`) means the new
protocol has landed in the schema and you can switch; if only the README changed while the schema
did not, the documentation still leads the implementation — keep waiting.

## Switch-over checklist (run once ready)

1. Rewrite `.release-policy.yml` for the new schema (take the fields and syntax from the schema,
   not just from the README).
2. Validate locally: `releasegraph inspect --path .release-policy.yml` (add `--output json` if
   needed).
3. Run the `Release` workflow manually with `dry_run=true` and confirm the plan and asset contract
   pass.
4. Merge the release PR and watch the real release, the tag and the fleet panel return to
   `HEALTHY`.
5. If the new engine also changes caller inputs or secret names, update
   `.github/workflows/release.yml` accordingly.
6. If any step fails, roll back to the v1 format and record the reason in this file.
