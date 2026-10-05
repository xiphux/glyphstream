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
 * `gh`, `pnpm` and `npm` are fakes first on PATH. `gh` serves a list of
 * workflow runs the way the API does -- filtered by workflow, branch and
 * `status` -- and runs the script's own `--jq` program over it with the real
 * jq, so the filters that keep a failed run or a pull request's run from
 * becoming a baseline are exercised rather than assumed. `<pnpm|npm> audit
 * --json` prints the audit-report.json committed in whichever tree it runs
 * in, so the baseline's worktree reports its own.
 *
 * Every child process gets an environment with no GITHUB_*, GIT_* or AUDIT_*
 * variables and no global git config, so neither a CI runner nor a developer's
 * shell (or a git hook's GIT_DIR) can change what these find.
 */

const root = process.cwd();
const BASELINE = path.join(root, 'scripts/audit-baseline.sh');
const AUDIT = path.join(root, 'scripts/audit-new-advisories.mjs');

let scratch: string;
let bin: string;

function cleanEnv(extra: Record<string, string | undefined> = {}) {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(GITHUB_|GIT_|AUDIT_)/.test(key)) env[key] = value;
	}
	return {
		...env,
		PATH: `${bin}:${process.env.PATH}`,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		...extra,
	};
}

beforeAll(() => {
	scratch = mkdtempSync(path.join(tmpdir(), 'audit-scripts-'));
	bin = path.join(scratch, 'bin');
	mkdirSync(bin);
	const fake = (name: string, body: string) => {
		writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(path.join(bin, name), 0o755);
	};
	// gh api -X GET repos/<repo>/actions/workflows/<file>/runs -f branch=<b>
	// [-f status=<s>] ... --jq <program>: the runs in $FAKE_RUNS/runs.json for
	// that workflow and branch -- and conclusion, if asked -- as
	// {workflow_runs: [...]}, through <program>.
	fake(
		'gh',
		[
			'[ -n "${FAKE_GH_FAIL:-}" ] && { echo "gh: HTTP 500" >&2; exit 1; }',
			'workflow="" branch="" status="" program=""',
			'while [ $# -gt 0 ]; do',
			'  case $1 in',
			'    */actions/workflows/*/runs) workflow=${1%/runs}; workflow=${workflow##*/} ;;',
			'    -f) case $2 in branch=*) branch=${2#branch=} ;; status=*) status=${2#status=} ;; esac; shift ;;',
			'    --jq) program=$2; shift ;;',
			'  esac',
			'  shift',
			'done',
			'jq --arg w "$workflow" --arg b "$branch" --arg s "$status" \\',
			'  \'{workflow_runs: [.[] | select(.workflow == $w and .head_branch == $b and ($s == "" or .conclusion == $s))]}\' \\',
			'  "$FAKE_RUNS/runs.json" | jq -r "$program"',
		].join('\n'),
	);
	// <pnpm|npm> audit --json ...: the tree's own report. FAKE_AUDIT_CONFIG
	// plays a repository whose configuration narrows the report -- auditLevel:
	// critical, optional: false, omit=optional -- which only the flags the
	// script pins restore. The arguments are logged to $FAKE_AUDIT_LOG.
	for (const [name, pinned] of [
		['pnpm', '--audit-level=low --optional'],
		['npm', '--include=optional'],
	]) {
		fake(
			name,
			[
				'echo "$*" >> "${FAKE_AUDIT_LOG:-/dev/null}"',
				'[ -n "${FAKE_AUDIT_GARBAGE:-}" ] && { echo "ERR_AUDIT_BAD_RESPONSE"; exit 1; }',
				'[ -n "${FAKE_AUDIT_ERROR_JSON:-}" ] && { echo \'{"error":{"code":"EAUDIT","summary":"bad response"}}\'; exit 1; }',
				'if [ -n "${FAKE_AUDIT_CONFIG:-}" ]; then',
				`  for want in ${pinned}; do`,
				'    case " $* " in *" $want "*) ;; *) echo \'{"advisories":{},"vulnerabilities":{}}\'; exit 0 ;; esac',
				'  done',
				'fi',
				'cat audit-report.json',
			].join('\n'),
		);
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

let repos = 0;
function makeRepo() {
	const dir = path.join(scratch, `repo-${repos++}`);
	mkdirSync(dir);
	const git = (...args: string[]) =>
		execFileSync('git', args, {
			cwd: dir,
			encoding: 'utf8',
			env: cleanEnv(),
		}).trim();
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

type Finding = {
	id: string;
	severity?: string;
	dev?: boolean;
	path?: string;
	/** The versions of the package it reaches, one finding each. */
	versions?: string[];
	noPaths?: boolean;
};
/** A `pnpm audit --json` report. */
const report = (...findings: Finding[]) => ({
	advisories: Object.fromEntries(
		findings.map((f, i) => [
			String(i),
			{
				github_advisory_id: f.id,
				severity: f.severity ?? 'high',
				module_name: 'pkg',
				title: `advisory ${f.id}`,
				findings: (f.versions ?? ['1.0.0']).map((version) => ({
					version,
					dev: f.dev ?? false,
					paths: f.noPaths ? [] : [f.path ?? `.>pkg@${version}`],
				})),
			},
		]),
	),
});
const CLEAN = report();

function audit(dir: string, env: Record<string, string | undefined> = {}) {
	const result = spawnSync('node', [AUDIT], {
		cwd: dir,
		encoding: 'utf8',
		env: cleanEnv(env),
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

	it('counts an advisory as new once it reaches another copy of the package', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-x', versions: ['1.0.0'] }), 'base');
		commit(
			report({ id: 'GHSA-x', versions: ['1.0.0', '2.0.0'] }),
			'a second vulnerable copy alongside the first',
		);
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('more copies than the baseline did: pkg@1.0.0, pkg@2.0.0');
	});

	it('does not count moving the one copy to another vulnerable version as new', () => {
		// The update a fix arrives through: failing it would block the fix.
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-x', versions: ['1.0.0'] }), 'base');
		commit(report({ id: 'GHSA-x', versions: ['1.0.1'] }), 'patch bump, still affected');
		const { status, out } = audit(dir);
		expect(status).toBe(0);
		expect(out).toContain('::warning title=Existing advisory::GHSA-x');
	});

	it('counts an advisory reported with no path at all', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-nopath', noPaths: true }), 'adds one');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-nopath');
	});

	it('pins what the audit reports, whatever the repository configures', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-new' }), 'adds one');
		const log = path.join(dir, '..', `${path.basename(dir)}.log`);
		const { status, out } = audit(dir, {
			FAKE_AUDIT_CONFIG: '1',
			FAKE_AUDIT_LOG: log,
		});
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-new');
		// Both audits, HEAD's and the baseline's.
		const calls = readFileSync(log, 'utf8').trim().split('\n');
		expect(calls).toEqual([
			'audit --json --audit-level=low --optional',
			'audit --json --audit-level=low --optional',
		]);
	});

	it('compares against $AUDIT_BASE, not the parent, when it is set', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(report({ id: 'GHSA-early' }), 'adds one');
		commit(report({ id: 'GHSA-early' }), 'unrelated tip');
		// Against the parent this would only warn: the multi-commit push.
		expect(audit(dir).status).toBe(0);
		const { status, out } = audit(dir, { AUDIT_BASE: green });
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-early');
	});

	it('counts everything as new with an empty $AUDIT_BASE', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-old' }), 'base');
		commit(report({ id: 'GHSA-old' }), 'tip');
		const { status, out } = audit(dir, { AUDIT_BASE: '' });
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-old');
	});

	it('refuses to fall back to the parent in CI when $AUDIT_BASE is missing', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir, { GITHUB_ACTIONS: 'true' });
		expect(status).toBe(1);
		expect(out).toContain('::error title=Audit failed::AUDIT_BASE is not set');
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
		for (const failure of ['FAKE_AUDIT_GARBAGE', 'FAKE_AUDIT_ERROR_JSON']) {
			const { status, out } = audit(dir, { [failure]: '1' });
			expect(status, failure).toBe(1);
			expect(out, failure).toContain('pnpm audit produced no report');
		}
	});
});

describe('audit-baseline.sh', () => {
	type Run = {
		sha: string;
		branch?: string;
		workflow?: string;
		event?: string;
		conclusion?: string;
		at?: string;
	};

	/**
	 * Runs the script as CI would; returns its status, output and chosen sha.
	 * `runs` are listed newest first unless they say when they ran.
	 */
	function baseline(dir: string, runs: Run[], env: Record<string, string | undefined> = {}) {
		const runsDir = mkdtempSync(path.join(scratch, 'runs-'));
		const api = runs.map((run, i) => ({
			workflow: run.workflow ?? 'ci.yml',
			head_branch: run.branch ?? 'main',
			head_sha: run.sha,
			event: run.event ?? 'push',
			status: 'completed',
			conclusion: run.conclusion ?? 'success',
			created_at: run.at ?? `2026-01-${String(28 - i).padStart(2, '0')}T00:00:00Z`,
			html_url: `https://example.test/run/${i}`,
		}));
		writeFileSync(path.join(runsDir, 'runs.json'), JSON.stringify(api));
		const output = path.join(runsDir, 'github-output');
		writeFileSync(output, '');
		const result = spawnSync('bash', [BASELINE], {
			cwd: dir,
			encoding: 'utf8',
			env: cleanEnv({
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
			}),
		});
		const sha = /^sha=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
		return { status: result.status, out: result.stdout + result.stderr, sha };
	}

	const PULL_REQUEST = {
		GITHUB_EVENT_NAME: 'pull_request',
		GITHUB_BASE_REF: 'main',
		GITHUB_REF_NAME: '1/merge',
	};

	it('prints the first parent outside Actions', () => {
		const { dir, commit } = makeRepo();
		const first = commit(CLEAN, 'one');
		commit(CLEAN, 'two');
		const out = execFileSync('bash', [BASELINE], {
			cwd: dir,
			encoding: 'utf8',
			env: cleanEnv(),
		}).trim();
		expect(out).toBe(first);
	});

	it('on a push, uses the last green run, however many commits came since', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(CLEAN, 'unverified 1');
		commit(CLEAN, 'unverified 2');
		const { status, sha } = baseline(dir, [{ sha: green }]);
		expect(status).toBe(0);
		expect(sha).toBe(green);
	});

	it('skips a run that failed, however recent', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		const red = commit(report({ id: 'GHSA-direct' }), 'red direct push');
		commit(report({ id: 'GHSA-direct' }), 'tip');
		const { sha } = baseline(dir, [{ sha: red, conclusion: 'failure' }, { sha: green }]);
		expect(sha).toBe(green);
	});

	it('skips a pull request’s run, even on a branch of the same name', () => {
		// A fork's branch can be called main; its run tested a merge commit, not
		// the head it reports.
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		const pr = commit(CLEAN, 'a pull request head, later merged');
		commit(CLEAN, 'tip');
		const { sha } = baseline(dir, [{ sha: pr, event: 'pull_request' }, { sha: green }]);
		expect(sha).toBe(green);
	});

	it('takes the newest green run across every listed workflow', () => {
		const { dir, commit } = makeRepo();
		const older = commit(CLEAN, 'green in ci.yml');
		const newer = commit(CLEAN, 'green in deploy.yml');
		commit(CLEAN, 'tip');
		const { sha } = baseline(
			dir,
			[
				{ sha: older, workflow: 'ci.yml', at: '2026-02-01T00:00:00Z' },
				{ sha: newer, workflow: 'deploy.yml', at: '2026-02-02T00:00:00Z' },
			],
			{ AUDIT_WORKFLOWS: 'ci.yml,deploy.yml' },
		);
		expect(sha).toBe(newer);
	});

	it('on a push, never compares a commit with itself', () => {
		const { dir, commit } = makeRepo();
		const earlier = commit(CLEAN, 'earlier green');
		const head = commit(CLEAN, 're-run of a green head');
		expect(baseline(dir, [{ sha: head }, { sha: earlier }]).sha).toBe(earlier);
	});

	it('skips runs that are not ancestors, or no longer exist', () => {
		const { dir, git, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		git('checkout', '-q', '-b', 'elsewhere');
		const elsewhere = commit(CLEAN, 'not an ancestor of main');
		git('checkout', '-q', 'main');
		commit(CLEAN, 'tip');
		const gone = 'f'.repeat(40);
		const { sha } = baseline(dir, [{ sha: gone }, { sha: elsewhere }, { sha: green }]);
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
		const { sha } = baseline(dir, [{ sha: green }], PULL_REQUEST);
		expect(sha).toBe(green);
		// And the audit then fails the PR on what the red push brought in.
		const { status, out } = audit(dir, { AUDIT_BASE: sha });
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-direct');
	});

	it('on a pull request, reads ancestry from the merge’s first parent', () => {
		// main was force-pushed back past a green commit the PR still contains:
		// that commit is in the merge, but no longer on the branch it targets.
		const { dir, git, commit } = makeRepo();
		const kept = commit(CLEAN, 'green, still on main');
		const dropped = commit(CLEAN, 'green, later dropped from main');
		git('checkout', '-q', '-b', 'pr');
		commit(CLEAN, 'pr change');
		git('checkout', '-q', 'main');
		git('reset', '-q', '--hard', kept);
		git('merge', '-q', '--no-ff', '-m', 'merge ref', 'pr');
		const { sha } = baseline(dir, [{ sha: dropped }, { sha: kept }], PULL_REQUEST);
		expect(sha).toBe(kept);
	});

	it('on a pull request into another branch, uses that branch', () => {
		const { dir, git, commit } = makeRepo();
		const onMain = commit(CLEAN, 'green main');
		git('checkout', '-q', '-b', 'release');
		const onRelease = commit(CLEAN, 'green release');
		git('checkout', '-q', '-b', 'pr');
		commit(CLEAN, 'pr change');
		git('checkout', '-q', 'release');
		git('merge', '-q', '--no-ff', '-m', 'merge ref', 'pr');
		const { sha } = baseline(
			dir,
			[
				{ sha: onRelease, branch: 'release' },
				{ sha: onMain, branch: 'main' },
			],
			{ ...PULL_REQUEST, GITHUB_BASE_REF: 'release' },
		);
		expect(sha).toBe(onRelease);
	});

	it('for a tag, uses the default branch, and not the tagged commit itself', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green main');
		const decoy = commit(CLEAN, 'green on a branch named like the tag');
		const tagged = commit(CLEAN, 'tagged, and green on main');
		const { sha } = baseline(
			dir,
			[
				{ sha: tagged, branch: 'main' },
				{ sha: decoy, branch: 'v1.0.0' },
				{ sha: green, branch: 'main' },
			],
			{ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.0.0' },
		);
		expect(sha).toBe(green);
	});

	it('falls back to the default branch, then to no baseline at all', () => {
		const { dir, git, commit } = makeRepo();
		const green = commit(CLEAN, 'green main');
		git('checkout', '-q', '-b', 'feature');
		commit(CLEAN, 'feature work');
		const onDefault = baseline(dir, [{ sha: green }], {
			GITHUB_REF_NAME: 'feature',
		});
		expect(onDefault.sha).toBe(green);
		const none = baseline(dir, [], { GITHUB_REF_NAME: 'feature' });
		expect(none.status).toBe(0);
		expect(none.sha).toBe('');
		expect(none.out).toContain('everything the audit finds counts as new');
	});

	it('fails when the run lookup fails, rather than guessing', () => {
		const { dir, commit } = makeRepo();
		const green = commit(CLEAN, 'green');
		commit(CLEAN, 'tip');
		const { status, sha } = baseline(dir, [{ sha: green }], {
			FAKE_GH_FAIL: '1',
		});
		expect(status).not.toBe(0);
		expect(sha).toBeUndefined();
	});

	it('fails in a shallow clone', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'one');
		commit(CLEAN, 'two');
		const shallow = path.join(scratch, `shallow-${repos++}`);
		execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], {
			env: cleanEnv(),
		});
		const { status, out, sha } = baseline(shallow, []);
		expect(status).not.toBe(0);
		expect(out).toContain('shallow');
		expect(sha).toBeUndefined();
	});
});
