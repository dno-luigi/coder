import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import { cleanupRun, installPrebuild, prepareRun, type TaskCard, verifyRun } from './index.js';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];
const repoRoot = process.cwd();
async function fixture(withGovernance = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'governed-harness-test-'));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (args: string[]) => execFile('git', args, { cwd: repo });
  await git(['init', '-q']); await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'first.txt'), 'base\n');
  if (withGovernance) {
    await cp(path.join(repoRoot, 'governance'), path.join(repo, 'governance'), { recursive: true });
    await installPrebuild(repo);
  }
  await git(['add', '.']); await git(['commit', '-qm', 'base']);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  const card: TaskCard = {
    schema_version: 1, task_id: `test-${Date.now()}-${Math.random()}`,
    authorization: { requested_by: 'operator-test', approved_at: new Date().toISOString(), scope: 'Change fixture file only' },
    repository: { base_commit: stdout.trim() },
    implementation: { instructions: 'Update first.txt', allowed_paths: ['first.txt'] },
    verification: { commands: [[process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync("first.txt", "utf8"))']], timeout_seconds: 10, acceptance_criteria: ['command exits zero'] },
  };
  return { root, repo, card };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('verifier checks a clean separate checkout of the exact candidate', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'VERIFIED');
  assert.notEqual(evidence.implementer.worktree, evidence.verifier.worktree);
  assert.equal(evidence.verifier.clean_before, true); assert.equal(evidence.verifier.clean_after, true);
  assert.equal(evidence.verifier.candidate_unchanged, true); assert.equal(evidence.commands[0].stdout, 'candidate\n');
  assert.equal(evidence.governance.agent_cannot_amend, true);
  await cleanupRun(prepared.runDir);
});

test('missing foundations fail closed before creating an implementer worktree', async () => {
  const { root, repo, card } = await fixture(false);
  await assert.rejects(prepareRun(card, repo, path.join(root, 'work')), /governance lock missing|foundation missing/);
  assert.equal(await readFile(path.join(repo, 'first.txt'), 'utf8'), 'base\n');
});

test('modified foundation is rejected against the installed prebuild lock', async () => {
  const { root, repo, card } = await fixture();
  await writeFile(path.join(repo, 'governance/ethical-constitution.md'), '# Active foundation v1\nTampered principles\n');
  await assert.rejects(prepareRun(card, repo, path.join(root, 'work')), /foundation modified since prebuild/);
});

test('task attempting to amend governance is rejected even when its task scope allows it', async () => {
  const { root, repo, card } = await fixture();
  card.implementation.allowed_paths = ['governance/'];
  card.implementation.instructions = 'Amend the active constitution';
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'governance/ethical-constitution.md'), '# Active foundation v1\nAgent amendment\n');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /cannot be amended by a task/);
  await cleanupRun(prepared.runDir);
});

test('governance drift between preparation and verification aborts verification', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(repo, 'governance/differential-operations.md'), '# Active foundation v1\nChanged after prepare\n');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /foundation modified since prebuild/);
  await cleanupRun(prepared.runDir);
});

test('failed verifier command is rejected and evidence records output and exit status', async () => {
  const { root, repo, card } = await fixture();
  card.verification.commands = [[process.execPath, '-e', 'process.stdout.write("proof-output"); process.stderr.write("proof-error"); process.exit(7)']];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED'); assert.equal(evidence.commands[0].exit_code, 7);
  assert.equal(evidence.commands[0].stdout, 'proof-output'); assert.equal(evidence.commands[0].stderr, 'proof-error');
  await cleanupRun(prepared.runDir);
});
