import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type TaskCard = {
  schema_version: 1;
  task_id: string;
  authorization: { requested_by: string; approved_at: string; scope: string };
  repository: { url?: string; base_commit: string };
  implementation: { instructions: string; allowed_paths: string[]; prohibited_actions?: string[] };
  verification: {
    commands: string[][];
    timeout_seconds: number;
    acceptance_criteria: string[];
    required_checks?: { candidate_unchanged?: boolean; verifier_worktree_clean?: boolean };
  };
  operator_gate?: { require_approval_before_durable_action?: boolean };
};

type RunManifest = {
  schema_version: 1;
  run_id: string;
  card: TaskCard;
  repo_path: string;
  implementation_path: string;
  created_at: string;
};

type CommandEvidence = {
  argv: string[];
  cwd: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
};

export type VerificationEvidence = {
  schema_version: 1;
  run_id: string;
  task_id: string;
  status: 'VERIFIED' | 'REJECTED';
  created_at: string;
  repository: { path: string; base_commit: string; candidate_commit: string; candidate_tree: string };
  patch_sha256: string;
  changed_paths: string[];
  implementer: { worktree: string };
  verifier: { worktree: string; distinct_from_implementer: boolean; clean_before: boolean; clean_after: boolean; candidate_unchanged: boolean };
  environment: { node: string; git: string; platform: string; arch: string };
  commands: CommandEvidence[];
  findings: string[];
  // The card's criteria are carried verbatim and never evaluated; the typed pair keeps them out of prose (D4).
  acceptance_criteria: string[];
  acceptance_criteria_evaluated: false;
  limitation: string;
};

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_FILE = 'run.json';
// task_id and run_id each name a filesystem entry, so both must be a single safe path segment.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// POSIX: the command leads its own process group, so a timeout can signal descendants instead of only the direct child.
const GROUP_KILL = process.platform !== 'win32';
// After 'exit', inherited pipes may still be open. Bound that wait before settling and stopping any survivor.
const OUTPUT_DRAIN_GRACE_MS = 500;
// After a timeout the whole group is signalled. If it still has not exited, settle the record anyway.
const KILL_GRACE_MS = 1000;

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`)));
  });
}

function normalizeRemote(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

// Second, independent guard behind the task_id character set: a generated name may never leave its configured root.
function directChild(root: string, name: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  if (typeof name !== 'string' || !RUN_ID.test(name)) throw new Error(`${label} must be a single path segment: ${JSON.stringify(name)}`);
  const candidate = path.join(resolvedRoot, name);
  if (path.dirname(candidate) !== resolvedRoot) throw new Error(`${label} resolves outside ${resolvedRoot}: ${JSON.stringify(name)}`);
  return candidate;
}

function validateCard(card: TaskCard): void {
  if (card?.schema_version !== 1) throw new Error('task card must have schema_version 1');
  if (typeof card.task_id !== 'string' || !RUN_ID.test(card.task_id)) {
    throw new Error('task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$: it names a run directory and an evidence file');
  }
  if (!card.authorization?.requested_by?.trim() || !card.authorization.scope?.trim() || !Number.isFinite(Date.parse(card.authorization.approved_at))) {
    throw new Error('task card requires authorization requester, scope, and RFC3339 approval timestamp');
  }
  if (card.repository?.url !== undefined && (typeof card.repository.url !== 'string' || !card.repository.url.trim())) {
    throw new Error('repository.url must be a non-empty string when present');
  }
  if (!/^[0-9a-f]{40,64}$/i.test(card.repository?.base_commit ?? '')) throw new Error('repository.base_commit must be a full Git object ID');
  if (!card.implementation?.instructions?.trim() || !Array.isArray(card.implementation.allowed_paths) || card.implementation.allowed_paths.length === 0) {
    throw new Error('implementation instructions and at least one allowed_paths entry are required');
  }
  for (const allowed of card.implementation.allowed_paths) {
    if (!allowed.trim() || path.isAbsolute(allowed) || allowed.split(/[\\/]/).includes('..')) throw new Error(`invalid allowed path: ${allowed}`);
  }
  if (card.implementation.prohibited_actions !== undefined &&
      (!Array.isArray(card.implementation.prohibited_actions) || card.implementation.prohibited_actions.some(entry => typeof entry !== 'string'))) {
    throw new Error('implementation.prohibited_actions must be an array of strings when present');
  }
  if (!Array.isArray(card.verification?.commands) || card.verification.commands.length === 0 ||
      card.verification.commands.some(command => !Array.isArray(command) || command.length === 0 || command.some(arg => typeof arg !== 'string')) ||
      !Number.isFinite(card.verification.timeout_seconds) || card.verification.timeout_seconds <= 0 ||
      !Array.isArray(card.verification.acceptance_criteria) || card.verification.acceptance_criteria.length === 0 ||
      card.verification.acceptance_criteria.some(entry => typeof entry !== 'string')) {
    throw new Error('verification requires non-empty argv commands, positive timeout, and acceptance criteria');
  }
  const checks = card.verification.required_checks;
  if (checks !== undefined) {
    for (const key of ['candidate_unchanged', 'verifier_worktree_clean'] as const) {
      const value = checks[key];
      if (value !== undefined && typeof value !== 'boolean') throw new Error(`verification.required_checks.${key} must be a boolean`);
      if (value === false) throw new Error(`verification.required_checks.${key} cannot be false: the harness always enforces this check`);
    }
  }
  const gate = card.operator_gate?.require_approval_before_durable_action;
  if (gate !== undefined && typeof gate !== 'boolean') throw new Error('operator_gate.require_approval_before_durable_action must be a boolean');
}

async function readManifest(runDir: string): Promise<RunManifest> {
  const manifest = JSON.parse(await readFile(path.join(runDir, RUN_FILE), 'utf8')) as RunManifest;
  if (manifest.schema_version !== 1) throw new Error('unsupported run manifest version');
  validateCard(manifest.card);
  if (typeof manifest.run_id !== 'string' || !RUN_ID.test(manifest.run_id)) throw new Error('run manifest run_id must be a single path segment');
  if (!manifest.run_id.startsWith(`${manifest.card.task_id}-`)) throw new Error('run manifest run_id does not belong to its task card');
  return manifest;
}

export async function prepareRun(card: TaskCard, repositoryPath: string, workRoot = path.join(os.tmpdir(), 'isolated-verifier')): Promise<{ runId: string; runDir: string; implementationPath: string }> {
  validateCard(card);
  const repoPath = await realpath(repositoryPath);
  if (card.repository.url !== undefined) {
    const remote = await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => '');
    if (normalizeRemote(remote) !== normalizeRemote(card.repository.url)) {
      throw new Error(`repository.url does not match the origin remote of ${repoPath}: ${card.repository.url}`);
    }
  }
  const base = await git(repoPath, ['rev-parse', '--verify', `${card.repository.base_commit}^{commit}`]);
  if (base !== card.repository.base_commit) throw new Error('resolved base commit does not match task card');
  await mkdir(workRoot, { recursive: true });
  const runId = `${card.task_id}-${randomUUID()}`;
  const runDir = directChild(await realpath(workRoot), runId, 'run directory');
  const implementationPath = path.join(runDir, 'implementer');
  await mkdir(runDir, { recursive: true });
  try {
    await git(repoPath, ['worktree', 'add', '--detach', implementationPath, base]);
    const manifest: RunManifest = { schema_version: 1, run_id: runId, card, repo_path: repoPath, implementation_path: implementationPath, created_at: new Date().toISOString() };
    await writeFile(path.join(runDir, RUN_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { runId, runDir, implementationPath };
  } catch (error) {
    await git(repoPath, ['worktree', 'remove', '--force', implementationPath]).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

function allowedPath(file: string, allowlist: string[]): boolean {
  return allowlist.some(entry => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    return file === normalized || (normalized.endsWith('/') && file.startsWith(normalized));
  });
}

function runCommand(argv: string[], cwd: string, timeoutSeconds: number): Promise<CommandEvidence> {
  return new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      // A new process group lets a timeout reach descendants. On Windows the direct child is all we can signal.
      detached: GROUP_KILL,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Do not pass the parent process's credentials/configuration wholesale to repository tests.
      env: Object.fromEntries(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'CI'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key] as string]])),
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let outputTruncated = false;
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += kept; else stderr += kept;
        bytes += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) outputTruncated = true;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // POSIX: the child leads its own group, so a negative PID signals the child and every descendant.
        if (GROUP_KILL) process.kill(-child.pid, name); else child.kill(name);
      } catch {
        // The group may already be gone; a surviving descendant is bounded by the grace timers below.
      }
    };
    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      resolve({ argv, cwd, started_at: started, finished_at: new Date().toISOString(), exit_code: code, timed_out: timedOut, stdout, stderr: error ? `${stderr}${error}` : stderr, output_truncated: outputTruncated });
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signal('SIGKILL');
      // A descendant that survives the group signal must not hold the evidence open.
      killTimer = setTimeout(() => finish(exitCode ?? -1), KILL_GRACE_MS);
    }, timeoutSeconds * 1000);
    child.once('error', error => finish(-1, error.message));
    child.once('exit', code => {
      exitCode = code;
      // A command that leaves a descendant holding the inherited pipes never emits 'close'. Let the timeout
      // decide that case (it signals the group), then bound the output drain so the record cannot hang.
      if (timedOut) drainTimer = setTimeout(() => { signal('SIGKILL'); finish(code ?? -1); }, OUTPUT_DRAIN_GRACE_MS);
    });
    child.once('close', code => finish(code ?? -1));
  });
}

// Ignored paths are invisible to `git add --all`, so they are detected separately with a read-only status
// call. They are never staged: an ignored write rejects the run instead of becoming candidate content (D3).
async function ignoredChanges(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  return raw.split('\0').filter(entry => entry.startsWith('!! ')).map(entry => entry.slice(3));
}

export async function verifyRun(runDir: string, evidenceDir: string): Promise<VerificationEvidence> {
  const manifest = await readManifest(runDir);
  const { card, repo_path: repo, implementation_path: implementation, run_id: runId } = manifest;
  const verifier = directChild(runDir, 'verifier', 'verifier worktree');
  // Throws below are reserved for states where no truthful record can be produced:
  // a missing/malformed manifest or implementation worktree, or a failure to create the verifier worktree.
  const resolvedImplementation = await realpath(implementation);
  const ignored = await ignoredChanges(resolvedImplementation);
  await git(resolvedImplementation, ['add', '--all']);
  // Ignored changes are not staged, so they cannot reach write-tree, diff-tree, changed_paths or the patch.
  const candidateTree = await git(resolvedImplementation, ['write-tree']);
  const changedRaw = await git(resolvedImplementation, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', card.repository.base_commit, candidateTree]);
  const changedPaths = changedRaw ? changedRaw.split('\0').filter(Boolean) : [];
  const denied = changedPaths.filter(file => !allowedPath(file, card.implementation.allowed_paths));
  const patch = await git(resolvedImplementation, ['diff', '--binary', card.repository.base_commit, candidateTree]);
  const candidateCommit = await git(resolvedImplementation, ['-c', 'user.name=Verifier MVP', '-c', 'user.email=verifier-mvp@localhost', 'commit-tree', candidateTree, '-p', card.repository.base_commit, '-m', `Candidate for ${card.task_id}`]);
  const findings: string[] = [];
  const commands: CommandEvidence[] = [];
  let verifierRealPath = verifier;
  let distinct = false;
  let cleanBefore = false;
  let cleanAfter = false;
  let candidateUnchanged = false;
  try {
    await git(repo, ['worktree', 'add', '--detach', verifier, candidateCommit]);
    verifierRealPath = await realpath(verifier);
    distinct = resolvedImplementation !== verifierRealPath;
    const before = await git(verifier, ['status', '--porcelain', '--untracked-files=all']);
    const initialHead = await git(verifier, ['rev-parse', 'HEAD']);
    const initialTree = await git(verifier, ['rev-parse', 'HEAD^{tree}']);
    cleanBefore = !before;
    // Pre-execution failures become a preserved REJECTED record instead of an exception with no evidence.
    if (denied.length) findings.push(`changed paths outside task scope: ${denied.join(', ')}`);
    // D3: detected read-only before the verifier worktree exists, so a rejected run executes nothing.
    const ignoredOutsideScope = ignored.filter(file => !allowedPath(file, card.implementation.allowed_paths));
    if (ignoredOutsideScope.length) findings.push(`ignored changes outside task scope: ${ignoredOutsideScope.join(', ')}`);
    if (ignored.length) findings.push(`ignored changes cannot be authorized: ${ignored.join(', ')}`);
    if (!distinct) findings.push('implementer and verifier worktrees resolve to the same path');
    if (before) findings.push(`verifier worktree is not clean before tests: ${before.split('\n').filter(Boolean).join(', ')}`);
    if (initialHead !== candidateCommit || initialTree !== candidateTree) findings.push('verifier checkout does not match pinned candidate');
    if (card.repository.url !== undefined) {
      const remote = await git(repo, ['remote', 'get-url', 'origin']).catch(() => '');
      if (normalizeRemote(remote) !== normalizeRemote(card.repository.url)) findings.push(`repository.url does not match the origin remote of ${repo}`);
    }
    const executed = findings.length === 0;
    if (executed) {
      for (const argv of card.verification.commands) commands.push(await runCommand(argv, verifierRealPath, card.verification.timeout_seconds));
    }
    const afterStatus = await git(verifier, ['status', '--porcelain', '--untracked-files=all']);
    const finalHead = await git(verifier, ['rev-parse', 'HEAD']);
    const finalTree = await git(verifier, ['rev-parse', 'HEAD^{tree}']);
    cleanAfter = !afterStatus;
    candidateUnchanged = finalHead === candidateCommit && finalTree === candidateTree;
    if (executed) {
      const failedCommands = commands.filter(command => command.exit_code !== 0 || command.timed_out);
      findings.push(
        ...failedCommands.map(command => `command failed (exit ${command.exit_code}${command.timed_out ? ', timed out' : ''}): ${command.argv.join(' ')}`),
        ...(!cleanAfter ? ['verifier worktree is dirty after tests'] : []),
        ...(!candidateUnchanged ? ['candidate commit/tree changed during verification'] : []),
      );
    }
  } finally {
    await git(repo, ['worktree', 'remove', '--force', verifier]).catch(() => undefined);
  }
  // Fields the card accepts but this harness does not evaluate are recorded as such, never left to be inferred as passed.
  const limitation = [
    'Git worktrees prove workspace separation and provenance, not OS-level containment. Repository tests run as this user; never use with hostile code or secrets.',
    card.implementation.prohibited_actions?.length ? `prohibited_actions are advisory and were not enforced: ${card.implementation.prohibited_actions.join(' | ')}` : '',
    card.operator_gate ? 'operator_gate.* settings are inert: this harness performs no durable action to gate.' : '',
  ].filter(Boolean).join(' ');
  const evidence: VerificationEvidence = {
    schema_version: 1, run_id: runId, task_id: card.task_id, status: findings.length ? 'REJECTED' : 'VERIFIED', created_at: new Date().toISOString(),
    repository: { path: repo, base_commit: card.repository.base_commit, candidate_commit: candidateCommit, candidate_tree: candidateTree },
    patch_sha256: createHash('sha256').update(patch).digest('hex'), changed_paths: changedPaths,
    implementer: { worktree: resolvedImplementation },
    verifier: { worktree: verifierRealPath, distinct_from_implementer: distinct, clean_before: cleanBefore, clean_after: cleanAfter, candidate_unchanged: candidateUnchanged },
    environment: { node: process.version, git: await git(repo, ['--version']), platform: process.platform, arch: process.arch },
    commands, findings,
    acceptance_criteria: [...card.verification.acceptance_criteria],
    acceptance_criteria_evaluated: false,
    limitation,
  };
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = directChild(await realpath(evidenceDir), `${runId}.json`, 'evidence file');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

export async function cleanupRun(runDir: string): Promise<void> {
  const manifest = await readManifest(runDir);
  await git(manifest.repo_path, ['worktree', 'remove', '--force', manifest.implementation_path]);
  await rm(runDir, { recursive: true, force: true });
}

export async function loadTaskCard(file: string): Promise<TaskCard> {
  const card = JSON.parse(await readFile(file, 'utf8')) as TaskCard;
  validateCard(card);
  return card;
}
