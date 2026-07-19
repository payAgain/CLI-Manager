# SSH Agent Integration Phase Progress

This is the single execution tracker for the task. Research, product requirements, design, scenario coverage, implementation order, and test strategy remain in this same task directory. A phase advances only after its focused checks pass; dependent phases run broader regression checks again.

| Order | Phase | Status | Focused verification |
|---|---|---|---|
| S01 | Config roots and launch injection | completed | migration, TS type-check, SSH launch Rust tests |
| S02 | Shared transport and Agent probe | completed | transport parity, probe/error classification, protocol tests |
| S03 | Agent install supply chain | completed | signature/hash/target/install/rollback tests |
| S04 | Remote Hook lifecycle | pending | adapter merge, ownership, atomicity, spool tests |
| S05 | Reusable Agent bridge runtime | pending | one-bridge invariant, reconnect, cancellation, shutdown tests |
| S06 | Remote history indexing and cache | pending | parser/index/catalog/cursor/offline tests |
| S07 | Remote session resume | pending | preflight/ownership/cwd/config-root routing tests |
| S08 | Read-only remote file panel | pending | confinement/read limits/provider routing tests |
| S09 | Read-only remote Git panel | pending | porcelain/diff/repo identity/read-only boundary tests |
| S10 | Stats, docs, security and release verification | pending | stats/performance/security/i18n/docs/full regression |

## Phase Checklists

### S01 Config roots and launch injection

- [x] Add migration and types for Host preferences, project override, installations, and per-root integrations.
- [x] Add per-Host Claude/Codex config-root UI and optional SSH project override.
- [x] Resolve project override -> Host preference -> native default for every common SSH launch path.
- [x] Validate and safely expand absolute POSIX, `~`, and `~/...` roots at the Rust boundary.
- [x] Preserve remote integration identity when a Host is locally deleted.
- [x] Pass TypeScript, focused SSH launch tests, migration test, and full Rust library regression.
- [x] Update SSH contract, `[TEMP]` changelog, and feature inventory for delivered behavior.

### S02 Shared transport and Agent probe

- [x] Extract shared `SshTransportSpec` for interactive PTY and non-interactive one-shot launches.
- [x] Preserve SSH Config, Agent, identity-file, credential-reference, ProxyJump, proxy, AskPass, timeout, and Host Key parameters.
- [x] Add explicit per-Host Agent probe with bounded banner/stdout/stderr parsing and stable error classes.
- [x] Persist sanitized version/protocol/target/path/status metadata without credentials or remote output.
- [x] Add bilingual probe status and diagnostics without automatic connection on page open.
- [x] Add focused transport, probe parser, banner limit, path, protocol mismatch, and Agent target tests.
- [x] Pass full TypeScript and Rust regression after task consolidation.
- [x] Update executable SSH Agent contract and delivered-behavior documentation.
- [x] Complete repeated review/fix cycles until the final review has no findings.
- [x] Commit S02 independently (`feat(ssh): add agent transport and probe`).

#### S02 Review Log

1. Review 1 found truncated frame headers treated as clean EOF and an optional bridge protocol. Fixed strict partial-header errors and required `--protocol`; Agent tests passed.
2. Review 2 found a dead `target()` wrapper after transport extraction. Removed it and restored warning-free `cargo check`.
3. Review 3 found `doctor` could exit before reporting `unsupported_target` when HOME was unavailable. Made status/doctor always structured and prevented failed doctor diagnostics from being marked usable.
4. Review 4 found no further issues. Final evidence: `npx tsc --noEmit`; desktop `cargo check`; desktop library tests `551 passed, 1 ignored`; Agent tests `10 passed`; CLI doctor smoke returned structured JSON.

### S03 Agent install supply chain

- [x] Add explicit per-Host preview, SSH stdin upload install/upgrade, rollback, uninstall, custom root, discovery metadata, and bilingual diagnostics.
- [x] Add Agent-owned install locking, staged self-check, version directories, atomic `current/previous` and launcher switching, corrupt-record recovery, downgrade protection, rollback, and transactional uninstall.
- [x] Add one signed manifest for desktop and POSIX script installation, reuse the Tauri updater Minisign trust root, and enforce HTTPS/default plus explicit signed HTTP mirror policy.
- [x] Add Linux x64/aarch64 release artifacts, size/SHA-256/target/protocol verification, manifest generation, release upload, and path-scoped Ubuntu Agent CI.
- [x] Add HTTP(S) installer dry-run/custom-root/downgrade/uninstall options without modifying Hook configuration.
- [x] Pass TypeScript, desktop Rust, Agent host tests, Linux x64/aarch64 all-target checks, POSIX installer smoke, manifest smoke, migration tests, and diff checks.
- [x] Update README, `[TEMP]` changelog, feature inventory, and executable SSH Agent contract.
- [x] Complete repeated review/fix cycles until the final review has no findings.

#### S03 Review Log

1. Review 1 found custom-root upgrades did not automatically reuse the discovery record, corrupt records permanently blocked repair, missing records could bypass downgrade checks, signed URLs accepted query/fragment ambiguity, and the script lacked strict download bounds. Fixed the shared install and URL-policy roots.
2. Review 2 found remote operation JSON was parsed but not contract-validated, and uninstall could leave partial state after a mid-operation failure. Added strict marker/action/identity/version/protocol/path/source/hash validation and a quarantine/restore uninstall transaction.
3. Review 3 found successful script installation bypassed temporary cleanup via `exec`, staged self-check omitted `doctor --self`, same-version reinstall produced false previous metadata, and public keys could drift across updater/desktop/script. Fixed cleanup and version semantics, added POSIX smoke coverage, centralized the public key, and made release generation verify all trust-root copies.
4. Review 4 found no further S03 issues. Final evidence: `npx tsc --noEmit`; desktop `cargo check`; desktop library tests `561 passed, 1 ignored` after one unrelated AskPass socket flake passed three focused reruns and the full rerun; Agent host tests `14 passed`; Linux x64/aarch64 `cargo check --all-targets`; POSIX installer smoke; manifest/key-consistency smoke; `git diff --check`.

### S04 Remote Hook lifecycle

- [ ] Implement Claude/Codex discovery, preview, install, upgrade, uninstall, and conflict diagnostics.
- [ ] Preserve third-party configuration and remove only CLI-Manager-owned entries.
- [ ] Implement bounded one-shot Hook IPC/spool behavior and lifecycle tests.

### S05 Reusable Agent bridge runtime

- [ ] Maintain at most one reusable bridge per Host/client while PTYs remain independent.
- [ ] Implement framing, capabilities, heartbeat, cancellation, backpressure, reconnect, and shutdown.
- [ ] Verify connection counts, multi-window ownership, banner contamination, and authentication-required behavior.

### S06 Remote history indexing and cache

- [ ] Implement incremental Claude/Codex adapters and the shared single-writer remote index.
- [ ] Register scoped remote source instances in the existing history catalog.
- [ ] Implement list/search/detail/diff/usage, freshness, stale/offline, cursor, rotate, and tombstone behavior.

### S07 Remote session resume

- [ ] Implement same-machine/user/source/config-root preflight and session ownership checks.
- [ ] Route Claude/Codex native resume into a new interactive SSH PTY.
- [ ] Support original remote location when the project is missing but Host identity is valid.

### S08 Read-only remote file panel

- [ ] Implement confined tree, search, text/image preview, path copy, and history/diff navigation.
- [ ] Hard-reject write, external opener, local filesystem, and Worktree operations.

### S09 Read-only remote Git panel

- [ ] Implement repository discovery, status, diff, branches, upstream, ahead/behind, and `asOf`.
- [ ] Use stable repo IDs and hard-reject mutation, network, credentials, Worktree, external diff, and textconv.

### S10 Stats, docs, security and release verification

- [ ] Integrate realtime Tab stats and historical usage with cache freshness/offline states.
- [ ] Verify provider isolation, connection/resource targets, security matrix, and zh-CN/en-US UI.
- [ ] Update README, `[TEMP]` changelog, feature inventory, code specs, and final test evidence.
- [ ] Run final change-scope audit and commit/archive the single task.

## Validation Gates

1. Focused gate: tests closest to the changed module plus formatting for touched Rust files.
2. Boundary gate: frontend-to-Rust payload validation, remote/local routing, credential and path confinement review.
3. Regression gate: `npx tsc --noEmit`, relevant Rust crate tests, and existing SSH tests.
4. Integration gate: dependent shard scenarios, connection-count checks, stale/offline behavior, and bilingual UI review.
5. Release gate: full allowed quality commands, change-scope audit, README/feature inventory/`[TEMP]` changelog review.
