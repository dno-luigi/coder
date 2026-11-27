Necessity Is the Mother of Invention

Why This Exists

This project began with a practical problem: the tools available to us were not enough to do the work we needed done.

We needed a coding agent that could do more than generate code. It had to understand the task, respect its boundaries, make changes in a real working environment, and prove that those changes worked.

We needed independent verification, not an agent congratulating itself for passing tests it had just written. We needed evidence tied to the exact source tree, not confident claims tied to an uncertain version of the code. And we needed the operator—not the model—to retain authority over consequential decisions.

The existing tools offered pieces of this capability. But the pieces did not automatically make a reliable system.

So we started designing one.

The Necessity

The problem was not a shortage of intelligence or code generation.

It was a shortage of trustworthy execution.

An agent could inspect a repository, propose a correction, and report success. But who independently checked the result? Did the verifier examine the same commit? Were the tests actually executed? Could the agent silently expand its assignment? Could a model authorize its own changes?

These are not theoretical concerns. They are failure points in real development workflows.

We learned that agreement between agents is not independent corroboration. A successful build is not proof that the requested experiment was valid. A passing test suite does not establish that the implementation respected its specification.

The system needed structural safeguards, not better assurances.

The Invention

The answer is an independently governed, multi-role coding architecture.

Four responsibilities form its foundation:

- Supervisor — interprets the assignment, establishes scope, coordinates work, and tracks evidence.
- Implementer — inspects the source, proposes changes, and executes authorized modifications.
- Verifier — independently checks the resulting source tree and runs the required tests.
- Operator — retains authority over approval, commits, merges, deployments, and policy decisions.

These are separate responsibilities, not merely four personalities assigned to the same conversation.

The architecture is designed so that the agent responsible for making a change cannot be the sole authority certifying that change.

The Governing Principle

Source is the record. Execution is reality. Evidence establishes what happened. The operator retains authority.

Every meaningful change should be attributable to a specific source state. Every verification result should identify the exact tree against which it was produced. Every uncertainty should remain visible rather than being converted into an unsupported conclusion.

The system should be able to explain:

- What was requested.
- What was authorized.
- What source state was inspected.
- What changed.
- What was independently executed.
- What the execution established.
- What remains unknown.
- Who authorized the next consequential action.

This is how we make agent behavior inspectable and reproducible.

Why Build Our Own?

Because dependency on a tool is not the same as control over a system.

Model providers, execution engines, APIs, and agent frameworks can change. Their capabilities are useful, but the architecture governing their use should remain ours.

The system should be able to substitute models, providers, tools, and execution environments without surrendering its fundamental rules.

We are not trying to build another chatbot with access to a terminal.

We are building an environment in which specialized AI capabilities can perform real work while remaining bounded by explicit authorization, independent measurement, and verifiable evidence.

The Larger Idea

Necessity may be the mother of invention, but invention alone is not enough.

A useful invention must survive contact with reality. It must expose its own limitations, preserve the evidence of its actions, and remain correctable by people who were not involved in producing the result.

That is the standard this project is working toward.

We did not set out to build an agent because agents were fashionable. We set out to build one because the work demanded a system we could actually trust—and the system did not yet exist in the form we needed.

So we are building it.


# Isolated verifier MVP

A small TypeScript harness to prove workspace separation and verification provenance with exactly one implementer worktree and one independently created verifier worktree. No model/provider integration is included. This is **not a security sandbox**; do not run hostile repository code or expose credentials.

## Requirements

- Node.js 20+
- Git

Install dependencies with `npm install`; run `npm test` and `npm run build`.

## Run the proof

Task cards are JSON for this MVP. Copy the shape below into `task-card.json`, replacing the base commit and scope with values for your repository:

```json
{
  "schema_version": 1,
  "task_id": "small-doc-change",
  "authorization": {
    "requested_by": "operator-name",
    "approved_at": "2026-01-15T12:00:00Z",
    "scope": "Update one documentation file"
  },
  "repository": { "base_commit": "<full-base-commit-sha>" },
  "implementation": {
    "instructions": "Make the authorized documentation change",
    "allowed_paths": ["docs/"],
    "prohibited_actions": ["commit to a durable branch", "merge or deploy"]
  },
  "verification": {
    "commands": [["node", "--version"]],
    "timeout_seconds": 60,
    "acceptance_criteria": ["The prescribed command exits successfully"],
    "required_checks": { "candidate_unchanged": true, "verifier_worktree_clean": true }
  },
  "operator_gate": { "require_approval_before_durable_action": true }
}
```

Prepare exactly one implementer worktree at the pinned base:

```sh
npm start -- prepare --card task-card.json --repo /path/to/repository --work-root /tmp/coder-work
```

The command prints `runDir` and `implementationPath`. Make the authorized changes in `implementationPath` only. Then independently pin and verify the resulting candidate:

```sh
npm start -- verify --run-dir /tmp/coder-work/<run-id> --evidence-dir /path/to/evidence
```

The harness stages the implementer changes — force-staging ignored paths so they cannot hide from scope or evidence — rejects paths outside `allowed_paths` and any ignored change, creates an immutable candidate commit object, then creates a **new detached verifier worktree** at that exact commit. Commands are argument arrays (no shell), run in the verifier directory with a timeout, minimal inherited environment, and bounded output. A scope violation, an ignored change, a dirty verifier checkout, or a checkout that does not match the pinned candidate produces persisted `REJECTED` evidence with `commands: []` and exit code 1; only a missing or malformed `run.json` and a failure to create the verifier worktree throw without a record. A timed-out command's whole process group is signalled on POSIX and the record settles within a 1 s grace; on Windows only the direct child is signalled. Evidence is written once to `<evidence-dir>/<run-id>.json`; failed commands yield `REJECTED` and exit code 1. The implementer worktree is retained for operator review until explicitly cleaned up:

```sh
npm start -- cleanup --run-dir /tmp/coder-work/<run-id>
```

The verifier worktree is removed after verification, including on failure. Evidence contains candidate/base IDs, changed paths, patch digest, worktree identities and cleanliness checks, command argv, timestamps, stdout/stderr, exit codes, and environment versions. Existing evidence files are never overwritten.

## Scope and security notes

- `allowed_paths` entries are exact paths or directory prefixes ending in `/`; glob syntax is not implemented.
- Git worktrees have distinct filesystems paths but share the repository object database and run under the same OS identity. This proves workspace separation/provenance only—not containment against malicious tests.
- Verification commands receive only a small environment allowlist, but filesystem access remains that of the invoking user. Do not rely on this as credential isolation; use a container or VM with restricted mounts, network, secrets, and resources before evaluating untrusted code.
- Verification evidence is append-only by run ID, but the filesystem is not tamper-proof against the local operator or process owner. Store/export records to a separately controlled system if stronger audit guarantees are required.
- No command commits to a durable branch, merges, deploys, or treats implementer-reported test results as evidence.
- `task_id` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`: it names the run directory and the evidence file, and the run directory must also resolve to a direct child of `--work-root`.
- Ignored paths are part of the record: ignored changes are force-staged, appear in `changed_paths`, and reject the run. An implementer that installs dependencies inside its worktree therefore makes the candidate and patch large; keep dependency trees out of the implementer worktree.
- A verifier command that leaves a descendant holding its inherited pipes does not end the run silently: the timeout signals the process group, the command is recorded as timed out, and the run is `REJECTED`.

## Task card field dispositions

Every field the card type accepts has a stated disposition; nothing is accepted and silently ignored.

- `task_id` — enforced. Single path segment matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; traversal, separators and a leading `.` are rejected at validation, and the run directory must resolve to a direct child of the work root.
- `repository.url` — enforced when present. It must match the implementation repository's `origin` remote, compared literally after ignoring a trailing `/` and a trailing `.git`.
- `repository.base_commit` — enforced. It must be a full commit object ID and must equal the resolved commit exactly.
- `implementation.allowed_paths` — enforced for tracked and ignored changes. Exact paths or directory prefixes ending in `/`; globs are not implemented.
- `verification.commands`, `verification.timeout_seconds` — enforced.
- `verification.required_checks.*` — enforced unconditionally. A `false` value is rejected at validation with a message naming the field, because the check cannot be disabled.
- `verification.acceptance_criteria` — recorded, not evaluated. They are copied verbatim into the evidence `limitation` text with an explicit not-evaluated marker; status derives only from command exit codes, worktree cleanliness and candidate identity.
- `implementation.prohibited_actions` — advisory. Entries must be strings; they are recorded in the evidence `limitation` text as unenforced and are never checked against behaviour.
- `operator_gate.*` — inert. Accepted, type-checked and recorded as inert, because this harness performs no durable action to gate.

