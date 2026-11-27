# Prebuild Foundations

This file is a versioned prebuild manifest. It must be present and verified before a run creates an agent, worktree, or project.

```yaml
schema_version: 1
prebuild_id: governance-foundations-v1
constitution:
  sha256: "TO_BE_FILLED_BY_INSTALL_SCRIPT"
  path: "governance/ethical-constitution.md"
differential_operations:
  sha256: "TO_BE_FILLED_BY_INSTALL_SCRIPT"
  path: "governance/differential-operations.md"
immutable:
  agent_cannot_amend: true
  amendment_requires_human_authority: true
  amendment_process: "Create a new version through a separately approved and reviewed change. Never mutate the active version in place."
```

The active governance files are part of the system's build inputs. Their SHA-256 digests are recorded in every run manifest and verification evidence.
