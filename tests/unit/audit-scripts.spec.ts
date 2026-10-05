import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * The dependency audit's two scripts, driven end to end against throwaway
 * repositories. CI's audit fails a change only for advisories it adds over a
 * baseline commit, so what decides the baseline (scripts/audit-baseline.sh)
 * and what counts as added (scripts/audit-new-advisories.mjs) are the whole
 * of the gate. An earlier version compared a push only with its parent, and
 * a pull request with the target branch's tip; both let an advisory through,
 * and both are pinned below.
 *
 * `gh` and `pnpm` are fakes first on PATH: `gh` serves canned run lists per
 * branch, and `pnpm audit --json` prints the audit-report.json committed in
 * whichever tree it runs in, so the baseline's worktree reports its own.
 */

const root = process.cwd();
const BASELINE = path.join(root, 'scripts/audit-baseline.sh');
const AUDIT = path.join(root, 'scripts/audit-new-advisories.mjs');

let scratch: string;
let bin: string;

beforeAll(() => {
	scratch = mkdtempSync(path.join(tmpdir(), 'audit-scripts-'));
	bin = path.join(scratch, 'bin');
	mkdirSync(bin);
	const fake = (name: string, body: string) => {
		writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(path.join(bin, name), 0o755);
	};
	// gh api ... -f branch=<b> ...: the lines in $FAKE_RUNS/<b>, as the real
	// call's --jq would print them; FAKE_GH_FAIL makes the call fail.
	fake(
		'gh',
		[
			'[ -n "${FAKE_GH_FAIL:-}" ] && { echo "gh: HTTP 500" >&2; exit 1; }',
			'for arg; do case $arg in branch=*) b=${arg#branch=};; esac; done',
			'cat "$FAKE_RUNS/$b" 2>/dev/null || true',
		].join('\n'),
	);
	// pnpm audit --json: the tree's own report, or garbage on request.
	fake(
		'pnpm',
		[
			'[ -n "${FAKE_PNPM_GARBAGE:-}" ] && { echo "ERR_PNPM_AUDIT_BAD_RESPONSE"; exit 1; }',
			'cat audit-report.json',
		].join('\n'),
	);
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

let repos = 0;
function makeRepo() {
	const dir = path.join(scratch, `repo-${repos++}`);
	mkdirSync(dir);
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'test');
	git('config', 'commit.gpgsign', 'false');
	const commit = (report: object, message: string) => {
		writeFileSync(path.join(dir, 'audit-report.json'), JSON.stringify(report));
		writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `# ${message}\n`);
		git('add', '-A');
		git('commit', '-q', '-m', message);
		return git('rev-parse', 'HEAD');
	};
	return { dir, git, commit };
}

type Finding = { id: string; severity?: string; dev?: boolean; path?: string };
const report = (...findings: Finding[]) => ({
	advisories: Object.fromEntries(
		findings.map((f, i) => [
			String(i),
			{
				github_advisory_id: f.id,
				severity: f.severity ?? 'high',
				module_name: 'pkg',
				title: `advisory ${f.id}`,
				findings: [{ dev: f.dev ?? false, paths: [f.path ?? '.>pkg'] }],
			},
		]),
	),
});
const CLEAN = report();

function audit(dir: string, env: Record<string, string | undefined> = {}) {
	const result = spawnSync('node', [AUDIT], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
	});
	return { status: result.status, out: result.stdout + result.stderr };
}

describe('audit-new-advisories.mjs', () => {
	it('fails on an advisory the change adds', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-new' }), 'adds one');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-new');
	});

	it('only warns on an advisory the baseline already had', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-old' }), 'base');
		commit(report({ id: 'GHSA-old' }), 'unrelated');
		const { status, out } = audit(dir);
		expect(status).toBe(0);
		expect(out).toContain('::warning title=Existing advisory::GHSA-old');
	});

	it('ignores advisories below high', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-mod', severity: 'moderate' }), 'moderate');
		expect(audit(dir).status).toBe(0);
	});

	it('counts a dev-only advisory as new once production code reaches it', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-x', dev: true, path: '.>tool>pkg' }), 'base');
		commit(report({ id: 'GHSA-x', dev: false, path: '.>pkg' }), 'to prod');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('only in devDependencies');
	});

	it('compares against $AUDIT_BASE, not the parent, when it is set', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(report({ id: 'GHSA-early' }), 'adds one');
		commit(report({ id: 'GHSA-early' }), 'unrelated tip');
		// Against the parent this would only warn: the multi-commit push.
		expect(audit(dir).status).toBe(0);
		expect(audit(dir, { AUDIT_BASE: green }).status).toBe(1);
	});

	it('counts everything as new with an empty $AUDIT_BASE', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-old' }), 'base');
		commit(report({ id: 'GHSA-old' }), 'tip');
		expect(audit(dir, { AUDIT_BASE: '' }).status).toBe(1);
	});

	it('fails closed on a baseline it cannot find', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir, { AUDIT_BASE: 'deadbeef' });
		expect(status).toBe(1);
		expect(out).toContain('::error title=Audit failed::');
	});

	it('fails closed when the audit produces no report', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir, { FAKE_PNPM_GARBAGE: '1' });
		expect(status).toBe(1);
		expect(out).toContain('produced no report');
	});
});

describe('audit-baseline.sh', () => {
	/** Runs the script as CI would; returns its status, output and chosen sha. */
	function baseline(
		dir: string,
		runs: Record<string, string[]>,
		env: Record<string, string | undefined>,
	) {
		const runsDir = mkdtempSync(path.join(scratch, 'runs-'));
		for (const [branch, shas] of Object.entries(runs)) {
			// Newest first, the way the real script sorts what gh returns.
			const lines = shas.map(
				(sha, i) =>
					`2026-01-${String(28 - i).padStart(2, '0')}T00:00:00Z ${sha} https://example.test/run/${i}`,
			);
			writeFileSync(path.join(runsDir, branch), `${lines.join('\n')}\n`);
		}
		const output = path.join(runsDir, 'github-output');
		writeFileSync(output, '');
		const result = spawnSync('bash', [BASELINE], {
			cwd: dir,
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				GITHUB_ACTIONS: 'true',
				GITHUB_OUTPUT: output,
				GITHUB_REPOSITORY: 'owner/repo',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF_NAME: 'main',
				GITHUB_REF_TYPE: 'branch',
				GH_TOKEN: 'token',
				AUDIT_WORKFLOWS: 'ci.yml',
				AUDIT_DEFAULT_BRANCH: 'main',
				FAKE_RUNS: runsDir,
				...env,
			},
		});
		const sha = /^sha=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
		return { status: result.status, out: result.stdout + result.stderr, sha };
	}

	it('prints the first parent outside Actions', () => {
		const { dir, commit } = makeRepo();
		const first = commit(CLEAN, 'one');
		commit(CLEAN, 'two');
		const out = execFileSync('bash', [BASELINE], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, GITHUB_ACTIONS: '' },
		}).trim();
		expect(out).toBe(first);
	});

	it('on a push, uses the last green run, however many commits came since', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(CLEAN, 'unverified 1');
		commit(CLEAN, 'unverified 2');
		const { status, sha } = baseline(dir, { main: [green] }, {});
		expect(status).toBe(0);
		expect(sha).toBe(green);
	});

	it('on a push, never compares a commit with itself', () => {
		const { dir, commit } = makeRepo();
		const earlier = commit(CLEAN, 'earlier green');
		const head = commit(CLEAN, 're-run of a green head');
		expect(baseline(dir, { main: [head, earlier] }, {}).sha).toBe(earlier);
	});

	it('skips runs that are not ancestors, or no longer exist', () => {
		const { dir, git, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		git('checkout', '-q', '-b', 'elsewhere');
		const elsewhere = commit(CLEAN, 'not an ancestor of main');
		git('checkout', '-q', 'main');
		commit(CLEAN, 'tip');
		const gone = 'f'.repeat(40);
		const { sha } = baseline(dir, { main: [gone, elsewhere, green] }, {});
		expect(sha).toBe(green);
	});

	it('on a pull request, uses the target branch’s last green run, not its tip', () => {
		const { dir, git, commit } = makeRepo();
		const green = commit(CLEAN, 'green main');
		commit(report({ id: 'GHSA-direct' }), 'red direct push to main');
		git('checkout', '-q', '-b', 'pr');
		commit(report({ id: 'GHSA-direct' }), 'pr change');
		git('checkout', '-q', 'main');
		git('merge', '-q', '--no-ff', '-m', 'merge ref', 'pr');
		const { sha } = baseline(
			dir,
			{ main: [green] },
			{
				GITHUB_EVENT_NAME: 'pull_request',
				GITHUB_BASE_REF: 'main',
				GITHUB_REF_NAME: '1/merge',
			},
		);
		expect(sha).toBe(green);
		// And the audit then fails the PR on what the red push brought in.
		expect(audit(dir, { AUDIT_BASE: sha }).status).toBe(1);
	});

	it('falls back to the default branch, then to no baseline at all', () => {
		const { dir, git, commit } = makeRepo();
		const green = commit(CLEAN, 'green main');
		git('checkout', '-q', '-b', 'feature');
		commit(CLEAN, 'feature work');
		const onDefault = baseline(dir, { main: [green] }, { GITHUB_REF_NAME: 'feature' });
		expect(onDefault.sha).toBe(green);
		const none = baseline(dir, {}, { GITHUB_REF_NAME: 'feature' });
		expect(none.status).toBe(0);
		expect(none.sha).toBe('');
		expect(none.out).toContain('every high or critical advisory counts as new');
	});

	it('fails when the run lookup fails, rather than guessing', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(CLEAN, 'tip');
		const { status, sha } = baseline(dir, { main: [green] }, { FAKE_GH_FAIL: '1' });
		expect(status).not.toBe(0);
		expect(sha).toBeUndefined();
	});

	it('fails in a shallow clone', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'one');
		commit(CLEAN, 'two');
		const shallow = path.join(scratch, `shallow-${repos++}`);
		execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
		expect(baseline(shallow, {}, {}).status).not.toBe(0);
	});
});
