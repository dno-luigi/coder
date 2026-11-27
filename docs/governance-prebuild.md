# Governance prebuild and enforcement

The harness verifies the two governance foundations before creating an implementer worktree. Run `npm run prebuild` during the trusted initial installation. This writes `governance/prebuild.lock.json`, pinning SHA-256 digests of both active foundation files. Subsequent prebuilds are check-only: changed or missing foundations fail instead of silently refreshing the lock.

Each prepared run records the governance version and both digests. Verification checks the lock and run pins again, and aborts on drift. Tasks may not change either foundation, the lock, or the prebuild manifest—even if the task allowlist explicitly includes governance files. Amendments must be separately reviewed and installed as a new version by a human-controlled process.

Tests exercise missing foundations, modified foundations, an attempted task amendment, and drift between preparation and verification. The local lock and evidence are not tamper-proof against an actor with filesystem or repository authority; use a separately controlled signature/key and immutable evidence store when that threat is in scope. This harness is not OS-level sandboxing.
