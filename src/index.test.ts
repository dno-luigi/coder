import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import { cleanupRun, prepareRun, type TaskCard, verifyRun } from './index.js';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isolated-verifier-test-'));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (args: string[]) => execFile('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);

  await mkdir(path.join(repo, 'governance'));
  await writeFile(path.join(repo, 'governance/ethical-constitution.md'), '**Status:** Active foundation v1\n');
  await writeFile(path.join(repo, 'governance/differential-operations.md'), '**Status:** Active foundation v1\n');
  await writeFile(path.join(repo, 'governance/prebuild.manifest.md'), 'prebuild\n');
  await writeFile(path.join(repo, 'first.txt'), 'base\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'base']);
  const { stdout } = await git(['rev-parse', 'HEAD']);

  const card: TaskCard = {
    schema_version: 1,
    task_id: `test-${Date.now()}`,
    authorization: { requested_by: 'operator-test', approved_at: new Date().toISOString(), scope: 'Change fixture file only' },
    repository: { base_commit: stdout.trim() },
    implementation: { instructions: 'Update first.txt', allowed_paths: ['first.txt'] },
    verification: { commands: [[process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync("first.txt", "utf8"))']], timeout_seconds: 10, acceptance_criteria: ['stdout contains candidate'] },
  };
  return { root, repo, card };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('verifier gets a separate clean checkout and records governance digests', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'VERIFIED');
  assert.notEqual(evidence.implementer.worktree, evidence.verifier.worktree);
  assert.equal(evidence.governance.prebuild_id, 'governance-foundations-v1');
  assert.match(evidence.governance.constitution.sha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.governance.differential_operations.sha256, /^[0-9a-f]{64}$/);
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
  await cleanupRun(prepared.runDir);
});

test('changes outside authorized paths are rejected', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'unauthorized.txt'), 'nope');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /outside task scope/);
  await cleanupRun(prepared.runDir);
});

test('governance foundations cannot be amended by a task', async () => {
  const { root, repo, card } = await fixture();
  card.implementation.allowed_paths = ['governance/'];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'governance/ethical-constitution.md'), '**Status:** Changed\n');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /governance foundations cannot be amended/);
  await cleanupRun(prepared.runDir);
});

test('governance changes after preparation invalidate the run', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(repo, 'governance/ethical-constitution.md'), '**Status:** Active foundation v1\nCHANGED\n');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /foundations changed after run preparation/);
  await cleanupRun(prepared.runDir);
});

test('missing governance foundations stop before worktree creation', async () => {
  const { root, repo, card } = await fixture();
  await rm(path.join(repo, 'governance/ethical-constitution.md'));
  await assert.rejects(prepareRun(card, repo, path.join(root, 'work')), /governance foundations are missing/);
});
