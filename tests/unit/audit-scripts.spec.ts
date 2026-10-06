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
	// critical, optional: false, a pnpmfile, omit= or offline=true in an
	// .npmrc, a registry= line, or the same in the environment -- which only
	// the flags the script pins, and the environment it strips, restore. The
	// arguments are logged to $FAKE_AUDIT_LOG.
	const REGISTRY = '--registry=https://registry.npmjs.org/';
	for (const [name, pinned] of [
		['pnpm', `--audit-level=low --optional ${REGISTRY} --ignore-pnpmfile`],
		[
			'npm',
			`--include=optional --include=peer ${REGISTRY} --offline=false --legacy-peer-deps=false`,
		],
	]) {
		fake(
			name,
			[
				'echo "$*" >> "${FAKE_AUDIT_LOG:-/dev/null}"',
				'[ -n "${FAKE_AUDIT_GARBAGE:-}" ] && { echo "ERR_AUDIT_BAD_RESPONSE"; exit 1; }',
				'[ -n "${FAKE_AUDIT_ERROR_JSON:-}" ] && { echo \'{"error":{"code":"EAUDIT","summary":"bad response"}}\'; exit 1; }',
				'if [ -n "${FAKE_AUDIT_CONFIG:-}" ]; then',
				'  empty() { echo \'{"advisories":{},"vulnerabilities":{}}\'; exit 0; }',
				`  for want in ${pinned}; do`,
				'    case " $* " in *" $want "*) ;; *) empty ;; esac',
				'  done',
				name === 'npm'
					? '  case " $* " in *" --omit=dev "*) ;; *" --include=dev "*) ;; *) empty ;; esac'
					: '  :',
				'  env | grep -qiE "^(npm_config_|pnpm_config_|node_env=|node_extra_ca_certs=|https?_proxy=)" && empty',
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
	// Writes a report (and its lockfile) to `at`, the repository root by
	// default, and commits everything.
	const commit = (
		report: object,
		message: string,
		at = '.',
		lockfile = 'pnpm-lock.yaml',
		lock = `# ${message}\n`,
	) => {
		mkdirSync(path.join(dir, at), { recursive: true });
		writeFileSync(path.join(dir, at, 'audit-report.json'), JSON.stringify(report));
		writeFileSync(path.join(dir, at, lockfile), lock);
		git('add', '-A');
		git('commit', '-q', '-m', message);
		return git('rev-parse', 'HEAD');
	};
	return { dir, git, commit };
}

type Copy = { version: string; dev?: boolean; paths?: string[] };
type Finding = {
	id: string;
	severity?: string;
	module?: string;
	/**
	 * The versions of the package it reaches, one finding each: `1.0.0`, or
	 * `1.0.0:dev` for one reached only through devDependencies, on a path of
	 * its own; or a Copy, to choose its paths.
	 */
	versions?: Array<string | Copy>;
	dev?: boolean;
	path?: string;
	noPaths?: boolean;
};
/**
 * A `pnpm audit --json` report: one advisory object per finding given, so two
 * with the same id are one GHSA split across objects, as pnpm reports one
 * that spans several vulnerable ranges.
 */
const report = (...findings: Finding[]) => ({
	advisories: Object.fromEntries(
		findings.map((f, i) => [
			String(1000 + i),
			{
				id: 1000 + i,
				github_advisory_id: f.id,
				severity: f.severity ?? 'high',
				module_name: f.module ?? 'pkg',
				title: `advisory ${f.id}`,
				findings: (f.versions ?? ['1.0.0']).map((entry) => {
					const copy: Copy =
						typeof entry === 'string'
							? {
									version: entry.split(':')[0],
									dev: entry.endsWith(':dev'),
								}
							: entry;
					return {
						version: copy.version,
						dev: copy.dev || (f.dev ?? false),
						paths: f.noPaths
							? []
							: (copy.paths ?? [f.path ?? `.>${f.module ?? 'pkg'}@${copy.version}`]),
					};
				}),
			},
		]),
	),
});
const CLEAN = report();

function audit(dir: string, env: Record<string, string | undefined> = {}, args: string[] = []) {
	const result = spawnSync('node', [AUDIT, ...args], {
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

	it('fails on a critical advisory the change adds, too', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-crit', severity: 'critical' }), 'adds one');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-crit (critical)');
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
		expect(out).toContain('the baseline had it only in devDependencies');
	});

	it('counts a dev-only advisory as new once production reaches it, with no path reported', () => {
		const { dir, commit } = makeRepo();
		commit(report({ id: 'GHSA-x', dev: true }), 'base');
		commit(report({ id: 'GHSA-x', noPaths: true }), 'to prod, pathless');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('Via (no path reported)');
	});

	it('merges one GHSA split across advisory objects, as pnpm reports ranges', () => {
		// The one copy moves from the advisory object for one vulnerable range
		// to the object for another: the same GHSA, not a new one.
		const { dir, commit } = makeRepo();
		// As real pnpm reports it: one object per vulnerable range, each with
		// findings of its own.
		commit(
			report(
				{ id: 'GHSA-split', versions: ['2.1.4:dev'] },
				{ id: 'GHSA-split', versions: ['5.0.9:dev'] },
			),
			'base',
		);
		commit(
			report(
				{ id: 'GHSA-split', versions: ['2.1.4:dev'] },
				{ id: 'GHSA-split', versions: ['5.0.9:dev', '5.0.10:dev'] },
			),
			'a partial fix in the 5.x range',
		);
		const { status, out } = audit(dir);
		expect(status).toBe(0);
		expect(out).toContain('::warning title=Existing advisory::GHSA-split');
		// Merged: the 2.x copy is on the baseline, though in another object.
		commit(report({ id: 'GHSA-split', versions: ['2.1.4:dev', '5.0.10:dev'] }), 'one object now');
		expect(audit(dir).status).toBe(0);
	});

	it('reads severity in any case', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-loud', severity: 'HIGH' }), 'adds one');
		expect(audit(dir).status).toBe(1);
	});

	it('escapes what it prints into workflow commands', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: '100%\r\n::error::forged' }), 'adds one');
		const { out } = audit(dir);
		expect(out).toContain('::error title=New advisory::100%25%0D%0A::error::forged');
		expect(out).not.toMatch(/^::error::forged/m);
	});

	it('pins what the audit reports, whatever the repository configures', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(report({ id: 'GHSA-new' }), 'adds one');
		const log = path.join(dir, '..', `${path.basename(dir)}.log`);
		const { status, out } = audit(dir, {
			FAKE_AUDIT_CONFIG: '1',
			FAKE_AUDIT_LOG: log,
			// Settings in the environment, which the audits must not see.
			NODE_ENV: 'production',
			npm_config_offline: 'true',
			PNPM_CONFIG_AUDIT_LEVEL: 'critical',
			HTTPS_PROXY: 'http://127.0.0.1:9/',
			NODE_EXTRA_CA_CERTS: '/dev/null',
		});
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-new');
		// Both audits, HEAD's and the baseline's.
		const call =
			'audit --json --audit-level=low --optional --registry=https://registry.npmjs.org/ --ignore-pnpmfile';
		expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([call, call]);
	});

	it.each([
		'https-proxy=http://127.0.0.1:9/',
		'proxy=http://127.0.0.1:9/',
		'strict-ssl=false',
		'cafile=/tmp/ca.pem',
		'ca="-----BEGIN CERTIFICATE-----"',
		'ca[]=x',
	])('refuses to audit with a committed .npmrc that sets %s', (setting) => {
		// Each can stand a server in for the registry, and no flag reliably
		// overrides it.
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		writeFileSync(path.join(dir, '.npmrc'), `registry=https://registry.npmjs.org/\n${setting}\n`);
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir);
		expect(status).toBe(1);
		expect(out).toContain('::error title=Audit failed::.npmrc sets');
	});

	it('does not refuse a scoped registry', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		writeFileSync(path.join(dir, '.npmrc'), '@scope:registry=https://npm.pkg.github.com\n');
		commit(CLEAN, 'tip');
		expect(audit(dir).status).toBe(0);
	});

	it('passes --prod through to pnpm', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(CLEAN, 'tip');
		const log = path.join(dir, '..', `${path.basename(dir)}.log`);
		expect(audit(dir, { FAKE_AUDIT_LOG: log }, ['--prod']).status).toBe(0);
		expect(readFileSync(log, 'utf8')).toMatch(/ --prod$/m);
	});

	it.each([
		'--ignore-registry-errors',
		'--no-optional',
		'--audit-level=critical',
		'--registry=http://127.0.0.1:9/',
		'--omit=optional',
		'--omit=dev', // npm's; pnpm's is --prod
	])('refuses %s, which would narrow the report', (flag) => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'base');
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir, {}, [flag]);
		expect(status).toBe(1);
		expect(out).toContain(`::error title=Audit failed::refusing ${flag}`);
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

	it('checks the baseline out without fetching LFS files', () => {
		// A checkout that dropped its credentials cannot download them, and the
		// audit needs only the lockfile: GIT_LFS_SKIP_SMUDGE. A smudge filter
		// that fails unless it is set stands in for an LFS download.
		const { dir, git, commit } = makeRepo();
		git('config', 'filter.lfs.clean', 'cat');
		git('config', 'filter.lfs.smudge', 'sh -c \'[ -n "$GIT_LFS_SKIP_SMUDGE" ] && cat || exit 1\'');
		git('config', 'filter.lfs.required', 'true');
		writeFileSync(path.join(dir, '.gitattributes'), '*.png filter=lfs\n');
		writeFileSync(path.join(dir, 'image.png'), 'not really a png\n');
		commit(CLEAN, 'base, with an LFS file');
		commit(CLEAN, 'tip');
		const { status, out } = audit(dir);
		expect(status, out).toBe(0);
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

describe('audit-new-advisories.mjs --npm', () => {
	type NpmFinding = {
		id: string;
		name?: string;
		severity?: string;
		packageSeverity?: string;
		alsoVia?: string[];
		/** Where each copy is installed, and its version there. */
		nodes?: string[];
		versions?: string[];
		/** Whether the lock marks its copies as devDependencies. */
		dev?: boolean;
	};
	/** An `npm audit --json` report: each finding a package with one advisory. */
	const npmReport = (...findings: NpmFinding[]) => ({
		vulnerabilities: Object.fromEntries(
			findings.map((f) => [
				f.name ?? 'pkg',
				{
					name: f.name ?? 'pkg',
					severity: f.packageSeverity ?? f.severity ?? 'high',
					via: [
						...(f.alsoVia ?? []),
						{
							source: 1000,
							name: f.name ?? 'pkg',
							title: `advisory ${f.id}`,
							url: `https://github.com/advisories/${f.id}`,
							severity: f.severity ?? 'high',
						},
					],
					nodes: f.nodes ?? [`node_modules/${f.name ?? 'pkg'}`],
				},
			]),
		),
	});
	/** The package-lock.json for those findings: each node at its version. */
	const npmLock = (...findings: NpmFinding[]) =>
		JSON.stringify({
			lockfileVersion: 3,
			packages: Object.fromEntries(
				findings.flatMap((f) =>
					(f.nodes ?? [`node_modules/${f.name ?? 'pkg'}`]).map((node, i) => [
						node,
						{
							version: f.versions?.[i] ?? '1.0.0',
							...(f.dev ? { dev: true } : {}),
						},
					]),
				),
			),
		});
	const args = ['--npm', '--dir=project', '--omit=dev'];
	const inProject = (
		commit: ReturnType<typeof makeRepo>['commit'],
		findings: NpmFinding[],
		message: string,
	) =>
		commit(npmReport(...findings), message, 'project', 'package-lock.json', npmLock(...findings));

	it('fails on an advisory the change adds, keyed by its GHSA id', () => {
		const { dir, commit } = makeRepo();
		inProject(commit, [], 'base');
		inProject(commit, [{ id: 'GHSA-aaaa-bbbb-cccc' }], 'adds one');
		const { status, out } = audit(dir, {}, args);
		expect(status).toBe(1);
		expect(out).toContain('::error title=New advisory::GHSA-aaaa-bbbb-cccc');
		expect(out).toMatch(/^project: 1 new/m);
	});

	it('audits the baseline’s copy of the same project, and only warns on what it had', () => {
		const { dir, commit } = makeRepo();
		inProject(commit, [{ id: 'GHSA-aaaa-bbbb-cccc' }], 'base');
		// A root report with something new must not leak into the project's.
		commit(report({ id: 'GHSA-root' }), 'root change');
		const { status, out } = audit(dir, {}, args);
		expect(status).toBe(0);
		expect(out).toContain('::warning title=Existing advisory::GHSA-aaaa-bbbb-cccc');
	});

	it('takes each advisory’s own severity, not the package’s worst', () => {
		const { dir, commit } = makeRepo();
		inProject(commit, [], 'base');
		inProject(
			commit,
			[
				{
					id: 'GHSA-mod',
					severity: 'moderate',
					packageSeverity: 'high',
					alsoVia: ['other-pkg'],
				},
			],
			'moderate, reached through another package',
		);
		expect(audit(dir, {}, args).status).toBe(0);
	});

	it('pins what npm reports, whatever an .npmrc or the environment says', () => {
		const { dir, commit } = makeRepo();
		inProject(commit, [], 'base');
		inProject(commit, [{ id: 'GHSA-aaaa' }], 'adds one');
		const log = path.join(dir, '..', `${path.basename(dir)}.log`);
		const env = {
			FAKE_AUDIT_CONFIG: '1',
			FAKE_AUDIT_LOG: log,
			NODE_ENV: 'production',
			npm_config_offline: 'true',
		};
		const pins =
			'audit --json --include=optional --include=peer --include=dev --registry=https://registry.npmjs.org/ --offline=false --legacy-peer-deps=false';
		expect(audit(dir, env, ['--npm', '--dir=project']).status).toBe(1);
		expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([pins, pins]);
	});

	it('leaves devDependencies out only when --omit=dev asks it to', () => {
		// npm's --include wins over --omit, so --include=dev goes with it.
		const { dir, commit } = makeRepo();
		inProject(commit, [], 'base');
		inProject(commit, [{ id: 'GHSA-aaaa' }], 'adds one');
		const log = path.join(dir, '..', `${path.basename(dir)}.log`);
		expect(audit(dir, { FAKE_AUDIT_CONFIG: '1', FAKE_AUDIT_LOG: log }, args).status).toBe(1);
		const call =
			'audit --json --include=optional --include=peer --registry=https://registry.npmjs.org/ --offline=false --legacy-peer-deps=false --omit=dev';
		expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([call, call]);
	});

	it('refuses --prod, which is pnpm’s', () => {
		const { dir, commit } = makeRepo();
		inProject(commit, [], 'base');
		inProject(commit, [{ id: 'GHSA-aaaa' }], 'tip');
		const { status, out } = audit(dir, {}, ['--npm', '--dir=project', '--prod']);
		expect(status).toBe(1);
		expect(out).toContain('refusing --prod: only --omit=dev may be passed to npm audit');
	});

	it('counts a project the baseline does not have yet as entirely new', () => {
		const { dir, commit } = makeRepo();
		commit(CLEAN, 'no project yet');
		inProject(commit, [{ id: 'GHSA-aaaa' }], 'adds the project');
		const { status, out } = audit(dir, {}, args);
		expect(status).toBe(1);
		expect(out).toMatch(/project is not in [0-9a-f]{12}: every advisory counts as new/);
	});

	it('fails closed on a report that is not npm’s', () => {
		const { dir, commit } = makeRepo();
		// A pnpm-shaped report read as npm: no `vulnerabilities`, so no report.
		commit(report(), 'base', 'project', 'package-lock.json', '{}');
		commit(report({ id: 'GHSA-x' }), 'tip', 'project', 'package-lock.json', '{}');
		const { status, out } = audit(dir, {}, args);
		expect(status).toBe(1);
		expect(out).toContain('npm audit produced no report');
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
