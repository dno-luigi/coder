# Prebuild Foundations

This versioned manifest describes the governing files. The explicit `npm run prebuild` installation step creates `prebuild.lock.json`, which records their SHA-256 digests. The lock is created once and is not refreshed automatically; an existing lock that does not match the foundations is a hard failure.

The manifest and lock are protected from task changes. Amendments require a separately authorized human-reviewed release that creates a new foundation version. They must not be made by an agent during a governed run.
