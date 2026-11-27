import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import { cleanupRun, loadTaskCard, prepareRun, type TaskCard, verifyRun } from './index.js';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];

async function installPostCheckoutHook(repo: string, forVerifier: string) {
  const hooks = path.join(repo, '.git', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\ncase "$PWD" in\n  */verifier)\n${forVerifier}\n    ;;\nesac\nexit 0\n`, { mode: 0o755 });
}

async function fixture(extra?: (repo: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isolated-verifier-test-'));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (args: string[]) => execFile('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'first.txt'), 'base\n');
  if (extra) await extra(repo);
  await git(['add', '.']);
  await git(['commit', '-qm', 'base']);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  const card: TaskCard = {
    schema_version: 1, task_id: `test-${Date.now()}`,
    authorization: { requested_by: 'operator-test', approved_at: new Date().toISOString(), scope: 'Change fixture file only' },
    repository: { base_commit: stdout.trim() },
    implementation: { instructions: 'Update first.txt', allowed_paths: ['first.txt'] },
    verification: { commands: [[process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync("first.txt", "utf8"))']], timeout_seconds: 10, acceptance_criteria: ['stdout contains candidate content'] },
  };
  return { root, repo, card };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('verifier gets a separate clean checkout of the exact candidate; later implementer edits stay out', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'VERIFIED');
  assert.notEqual(evidence.implementer.worktree, evidence.verifier.worktree);
  assert.equal(evidence.verifier.clean_before, true);
  assert.equal(evidence.verifier.clean_after, true);
  assert.equal(evidence.verifier.candidate_unchanged, true);
  assert.equal(evidence.commands[0].stdout, 'candidate\n');
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'late implementer mutation\n');
  assert.equal(await readFile(path.join(prepared.implementationPath, 'first.txt'), 'utf8'), 'late implementer mutation\n');
  assert.equal(evidence.commands[0].stdout.includes('late implementer'), false);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'VERIFIED');
  await cleanupRun(prepared.runDir);
});

test('failing verifier command is rejected and raw output/exit code are persisted', async () => {
  const { root, repo, card } = await fixture();
  card.verification.commands = [[process.execPath, '-e', 'process.stdout.write("proof-output"); process.stderr.write("proof-error"); process.exit(7)']];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands[0].exit_code, 7);
  assert.equal(evidence.commands[0].stdout, 'proof-output');
  assert.equal(evidence.commands[0].stderr, 'proof-error');
  assert.match(evidence.findings[0], /command failed/);
  await cleanupRun(prepared.runDir);
});

// P0-1: the timeout must bound wall-clock time and stop the process group, not only the direct child.
test('a descendant holding the inherited pipes cannot extend the run past the timeout grace', { skip: process.platform === 'win32' }, async () => {
  const { root, repo, card } = await fixture();
  const pidFile = path.join(root, 'grandchild.pid');
  card.verification.timeout_seconds = 1;
  card.verification.commands = [[process.execPath, '-e',
    `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.exit(0)`]];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const started = Date.now();
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  const elapsed = Date.now() - started;
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands[0].timed_out, true);
  assert.ok(elapsed < 3_500, `run settled after ${elapsed} ms; timeout was 1000 ms with a 1000 ms grace`);
  assert.equal(alive, false, `descendant ${pid} survived the run`);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.commands[0].timed_out, true);
  await cleanupRun(prepared.runDir);
});

// P0-2 / D3: an ignored write is detected read-only and rejected; it must never become candidate content.
test('an ignored change is detected and rejected without entering the candidate', async () => {
  const { root, repo, card } = await fixture(async repoPath => { await writeFile(path.join(repoPath, '.gitignore'), 'secret.env\n'); });
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  await writeFile(path.join(prepared.implementationPath, 'secret.env'), 'TOKEN=leaked\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.match(evidence.findings.join('\n'), /secret\.env/);
  assert.equal(evidence.changed_paths.includes('secret.env'), false, `ignored path entered changed_paths: ${evidence.changed_paths.join(', ')}`);
  assert.equal(evidence.commands.length, 0);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'REJECTED');
  assert.equal(persisted.changed_paths.includes('secret.env'), false);
  assert.equal(persisted.commands.length, 0);
  // Neither the candidate tree nor the patch absorbed the ignored content.
  await assert.rejects(execFile('git', ['cat-file', '-e', `${evidence.repository.candidate_tree}:secret.env`], { cwd: repo }));
  const diff = await execFile('git', ['diff', '--binary', card.repository.base_commit, evidence.repository.candidate_tree], { cwd: repo });
  assert.equal(diff.stdout.includes('secret.env'), false, 'patch text contained the ignored path');
  await cleanupRun(prepared.runDir);
});

// P0-3: task_id is interpolated into a path; traversal must fail before anything is created.
test('task_id traversal and separators are rejected before any directory is created', async () => {
  const { root, repo, card } = await fixture();
  const workRoot = path.join(root, 'work');
  for (const [index, taskId] of ['../escaped-task', '..', '.', 'nested/task', 'nested\\task', '.hidden'].entries()) {
    await assert.rejects(prepareRun({ ...card, task_id: taskId }, repo, workRoot), /task_id/);
    const cardFile = path.join(root, `card-${index}.json`);
    await writeFile(cardFile, JSON.stringify({ ...card, task_id: taskId }));
    await assert.rejects(loadTaskCard(cardFile), /task_id/);
  }
  await assert.rejects(access(workRoot), /ENOENT/);
  await assert.rejects(access(path.join(root, 'escaped-task')), /ENOENT/);
});

test('a tampered run manifest whose run_id escapes the run directory is refused', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  const manifestPath = path.join(prepared.runDir, 'run.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, run_id: '../../escaped' }));
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /run_id/);
  await rm(prepared.runDir, { recursive: true, force: true });
});

// P1-4: a scope violation must leave a REJECTED record instead of throwing without evidence.
test('an out-of-scope change produces persisted REJECTED evidence and no verifier execution', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'unauthorized.txt'), 'nope');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands.length, 0);
  assert.match(evidence.findings.join('\n'), /unauthorized\.txt/);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'REJECTED');
  assert.equal(persisted.commands.length, 0);
  await cleanupRun(prepared.runDir);
});

test('a dirty verifier checkout produces persisted REJECTED evidence', async () => {
  const { root, repo, card } = await fixture();
  await installPostCheckoutHook(repo, '    printf "dirty\\n" > unexpected-before-tests.txt');
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.verifier.clean_before, false);
  assert.equal(evidence.commands.length, 0);
  assert.match(evidence.findings.join('\n'), /not clean before tests/);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'REJECTED');
  await cleanupRun(prepared.runDir);
});

test('a verifier checkout that does not match the pinned candidate produces persisted REJECTED evidence', async () => {
  const { root, repo, card } = await fixture();
  await installPostCheckoutHook(repo, `    gitdir=$(cd "$(git rev-parse --git-dir)" && pwd)\n    printf '%s\\n' ${card.repository.base_commit} > "$gitdir/HEAD"`);
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands.length, 0);
  assert.match(evidence.findings.join('\n'), /does not match pinned candidate/);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'REJECTED');
  await cleanupRun(prepared.runDir);
});

// P1-5: repository.url is enforced against the implementation remote.
test('repository.url is enforced against the origin remote', async () => {
  const { root, repo, card } = await fixture(async repoPath => { await execFile('git', ['remote', 'add', 'origin', 'https://example.invalid/coder.git'], { cwd: repoPath }); });
  await assert.rejects(
    prepareRun({ ...card, repository: { ...card.repository, url: 'https://example.invalid/other.git' } }, repo, path.join(root, 'work')),
    /repository\.url/,
  );
  const prepared = await prepareRun({ ...card, repository: { ...card.repository, url: 'https://example.invalid/coder.git/' } }, repo, path.join(root, 'work'));
  assert.ok(prepared.runDir);
  await cleanupRun(prepared.runDir);
});

// P1-5: required_checks values are unconditional; false cannot be accepted as if it disabled them.
test('a required check the harness always enforces cannot be disabled by the card', async () => {
  const { root, card } = await fixture();
  const cardFile = path.join(root, 'checks.json');
  await writeFile(cardFile, JSON.stringify({ ...card, verification: { ...card.verification, required_checks: { candidate_unchanged: false } } }));
  await assert.rejects(loadTaskCard(cardFile), /candidate_unchanged/);
});

test('prohibited_actions must be strings', async () => {
  const { root, card } = await fixture();
  const cardFile = path.join(root, 'prohibited.json');
  await writeFile(cardFile, JSON.stringify({ ...card, implementation: { ...card.implementation, prohibited_actions: ['merge', 7] } }));
  await assert.rejects(loadTaskCard(cardFile), /prohibited_actions/);
});

// P1-5: accepted-but-unevaluated fields are recorded as such in the evidence.
test('acceptance criteria, prohibited actions and operator gate are recorded as not evaluated', async () => {
  const { root, repo, card } = await fixture();
  card.verification.acceptance_criteria = ['stdout contains candidate content'];
  card.implementation.prohibited_actions = ['merge', 'deploy'];
  card.operator_gate = { require_approval_before_durable_action: true };
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'VERIFIED');
  // D4: the criteria are a typed field, and the prose that duplicated them is gone.
  assert.deepEqual(evidence.acceptance_criteria, ['stdout contains candidate content']);
  assert.equal(evidence.acceptance_criteria_evaluated, false);
  assert.doesNotMatch(evidence.limitation, /Acceptance criteria/);
  assert.doesNotMatch(evidence.limitation, /stdout contains candidate content/);
  assert.match(evidence.limitation, /prohibited_actions are advisory/);
  assert.match(evidence.limitation, /operator_gate\.\* settings are inert/);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.deepEqual(persisted.acceptance_criteria, ['stdout contains candidate content']);
  assert.equal(persisted.acceptance_criteria_evaluated, false);
  await cleanupRun(prepared.runDir);
});

// D4: the marker must exist on the pre-execution rejection path too, not only when a command ran.
test('a pre-execution rejection carries the acceptance-criteria marker', async () => {
  const { root, repo, card } = await fixture();
  card.verification.acceptance_criteria = ['only first.txt may change'];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'unauthorized.txt'), 'nope');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands.length, 0);
  assert.deepEqual(evidence.acceptance_criteria, ['only first.txt may change']);
  assert.equal(evidence.acceptance_criteria_evaluated, false);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.deepEqual(persisted.acceptance_criteria, ['only first.txt may change']);
  assert.equal(persisted.acceptance_criteria_evaluated, false);
  await cleanupRun(prepared.runDir);
});
