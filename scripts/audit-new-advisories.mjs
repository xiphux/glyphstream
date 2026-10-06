#!/usr/bin/env node
/**
 * Fail on the high and critical advisories this change adds, not on every one
 * in the lockfile.
 *
 * `pnpm audit --audit-level=high` on its own fails whenever any such advisory
 * exists, so one published against a package already locked -- with or
 * without a fix -- failed every pull request until someone dealt with it,
 * whatever the pull request changed. Worse, two Renovate PRs that each fixed
 * one advisory could never merge: each still carried the other's. The
 * question a pull request can answer is whether it makes things worse, so
 * that is what this asks.
 *
 * It audits HEAD and a baseline commit and fails only on advisories HEAD has
 * that the baseline does not. The baseline is $AUDIT_BASE, which CI sets from
 * scripts/audit-baseline.sh: the last commit a successful CI run passed on the
 * target branch, on a pull request as well as a push. That is what keeps a
 * push of several commits, a run that failed and was followed by another, or a
 * pull request onto a tip that failed, from passing an advisory nothing ever
 * compared against a state without it. Unset (a local run), the baseline is
 * HEAD's first parent -- outside CI only: in CI an unset $AUDIT_BASE means the
 * step lost it, and fails. Set but empty, there is no baseline and every
 * advisory counts as new.
 *
 * Advisories are compared by id, not by the dependency paths or versions
 * that reach them: a routine update that reshuffles the tree around a
 * package already flagged -- eslint-plugin-n 18.4.0 added seven paths to a
 * brace-expansion advisory glyphstream already had -- must not fail, or this
 * is the blocking it replaced. So another copy of an advisory the baseline
 * already had, on a new path or at another version, only warns. One
 * distinction is kept: an advisory the baseline had only in devDependencies
 * counts as new once HEAD reaches it from production dependencies, so the
 * dev tree cannot vouch for what ships. Every path is printed.
 *
 * Findings already on the baseline are printed as warnings and do not fail
 * the run. They stay visible there, as Dependabot alerts, and as Renovate's
 * security PRs; the weekly lockFileMaintenance PR picks up in-range fixes.
 * An advisory reviewed and found unreachable still belongs in the audit's own
 * ignore list (auditConfig.ignoreGhsas in pnpm-workspace.yaml) with its reason
 * -- each side is audited with its own copy, so adding an entry clears the
 * warning, and removing one that is still needed fails.
 *
 * Usage: audit-new-advisories.mjs [--npm] [--dir=<path>] [audit arguments]
 *
 *   --npm         audit an npm project (package-lock.json) with `npm audit`
 *                 rather than the pnpm workspace with `pnpm audit`
 *   --dir=<path>  the project to audit, relative to the repository root
 *                 (default: the root). A project the baseline does not have
 *                 yet counts as entirely new.
 *
 * The only other argument accepted, and passed to both audits, is the one
 * that leaves out what does not ship -- `--prod` for pnpm, `--omit=dev` for
 * npm. Anything else is refused: the rest of what the tools accept narrows
 * the report or makes a failure read as clean.
 *
 * Configuration can do the same without saying so, so what the audits report
 * is pinned on the command line, ahead of that argument: the severity
 * (`auditLevel: critical` in pnpm-workspace.yaml empties the JSON of every
 * high advisory), optional, peer and dev dependencies (`optional: false`,
 * `omit=` in an .npmrc), the registry (`registry=` sends the audit to a
 * server whose empty answer reads as clean), npm's `offline` and
 * `legacy-peer-deps`, and pnpm's pnpmfile hooks, which can rewrite any of it.
 * The same settings in the environment are dropped. A committed .npmrc that
 * sets a proxy or a certificate authority -- which can stand a server in for
 * the registry, and which no command-line flag reliably overrides -- makes
 * the audit refuse to run. The severity this cares about is filtered here,
 * not by the tool. (Each side runs the pnpm its own `packageManager` names,
 * so a change that bumps pnpm compares two versions' reports.)
 *
 * None of that is a defence against someone set on getting an advisory past
 * review: the audit runs this script from the commit under test, which they
 * could edit as easily. It is against configuration added for some other
 * reason quietly turning the audit off.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SEVERE = new Set(['high', 'critical']);

const options = { npm: false, dir: '.' };
const args = [];
for (const arg of process.argv.slice(2)) {
	if (arg === '--npm') options.npm = true;
	else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
	else args.push(arg);
}
const tool = options.npm ? 'npm' : 'pnpm';
const lockfile = options.npm ? 'package-lock.json' : 'pnpm-lock.yaml';
const allowed = options.npm ? '--omit=dev' : '--prod';
const auditArgs = args.filter((arg) => arg === allowed);
const refused = args.filter((arg) => arg !== allowed);
const registry = '--registry=https://registry.npmjs.org/';
const pinned = options.npm
	? [
			'--include=optional',
			'--include=peer',
			// npm's --include wins over --omit, so dev only when it is not omitted.
			...(auditArgs.includes('--omit=dev') ? [] : ['--include=dev']),
			registry,
			'--offline=false',
			'--legacy-peer-deps=false',
		]
	: ['--audit-level=low', '--optional', registry, '--ignore-pnpmfile'];
// The audits' environment, without the settings that would narrow them or
// route them elsewhere: npm reads NODE_ENV=production as omitting dev.
const auditEnv = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) =>
			!/^(npm_config_|pnpm_config_|node_env$|node_extra_ca_certs$|(https?|all|no)_proxy$)/i.test(
				key,
			),
	),
);
// .npmrc settings that route an audit through something other than the
// registry, which no flag here reliably overrides.
const ROUTING = /^\s*(https?[-_]?proxy|proxy|no[-_]?proxy|strict[-_]?ssl|ca(\[\])?|cafile)\s*=/im;

// GIT_LFS_SKIP_SMUDGE: the audit needs the lockfile, not the baseline's LFS
// files, and checkouts here drop their credentials, so an LFS download
// during `git worktree add` would fail the run.
const git = (...gitArgs) =>
	execFileSync('git', gitArgs, {
		encoding: 'utf8',
		env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
	}).trim();

/** Adds one finding's paths to `advisories`, keyed by advisory id. */
function record(advisories, { id, severity, module, title, paths, prod }) {
	const entry = advisories.get(id) ?? {
		id,
		severity,
		module,
		title,
		paths: new Set(),
		prodPaths: new Set(),
		// Whether any finding of it is reached from production dependencies:
		// pnpm sets `dev` per finding, not per path.
		prod: false,
	};
	// A finding reported with no path still has something to print.
	for (const dependencyPath of paths?.length ? paths : ['(no path reported)']) {
		entry.paths.add(dependencyPath);
		if (prod) entry.prodPaths.add(dependencyPath);
	}
	entry.prod ||= prod;
	advisories.set(id, entry);
}

const severe = (severity) => SEVERE.has(String(severity).toLowerCase());

/**
 * `pnpm audit --json`: advisories, each with findings that carry their
 * dependency paths and whether they are reached only through devDependencies.
 */
function readPnpm(report, advisories) {
	if (typeof report.advisories !== 'object' || report.advisories === null) return false;
	for (const advisory of Object.values(report.advisories)) {
		if (!severe(advisory.severity)) continue;
		for (const finding of advisory.findings) {
			record(advisories, {
				id: advisory.github_advisory_id ?? `npm-${advisory.id}`,
				severity: advisory.severity,
				module: advisory.module_name,
				title: advisory.title,
				paths: finding.paths,
				prod: finding.dev !== true,
			});
		}
	}
	return true;
}

/**
 * `npm audit --json`: vulnerable packages, each listing the advisories that
 * make it so under `via`. A package's own severity is the worst of those, so
 * it is each advisory's that counts. `via` also names other packages, by
 * string, when the problem is in a dependency; those are listed again under
 * their own name, so only the advisory objects are read. npm's report does not
 * say which copies are dev dependencies, so these count as production; with
 * `--omit=dev`, they are.
 */
function readNpm(report, advisories) {
	if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
		return false;
	}
	for (const vulnerability of Object.values(report.vulnerabilities)) {
		for (const via of vulnerability.via) {
			if (typeof via === 'string' || !severe(via.severity)) continue;
			record(advisories, {
				id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`,
				severity: via.severity,
				module: via.name,
				title: via.title,
				paths: vulnerability.nodes,
				prod: true,
			});
		}
	}
	return true;
}

/** Refuses to audit `cwd` if a committed .npmrc routes the audit elsewhere. */
function refuseRouting(cwd, root) {
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		const npmrc = path.join(dir, '.npmrc');
		const setting = existsSync(npmrc) ? ROUTING.exec(readFileSync(npmrc, 'utf8')) : null;
		if (setting) {
			throw new Error(
				`${path.relative(root, npmrc) || '.npmrc'} sets ${setting[1]}, which can route the audit through something other than the registry: remove it, or audit without it`,
			);
		}
		if (dir === root || dir === path.dirname(dir)) return;
	}
}

/** High and critical advisories, by id, with the paths that reach them. */
function audit(cwd, root) {
	refuseRouting(cwd, root);
	const result = spawnSync(tool, ['audit', '--json', ...pinned, ...auditArgs], {
		cwd,
		encoding: 'utf8',
		env: auditEnv,
		maxBuffer: 64 * 1024 * 1024,
	});
	const stdout = result.stdout ?? '';
	const advisories = new Map();
	let read = false;
	try {
		// From the first brace: pnpm prints warnings to stdout ahead of the JSON,
		// such as an engines mismatch on the Node version.
		const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
		read = (options.npm ? readNpm : readPnpm)(report, advisories);
	} catch {
		// Fall through: an unreadable report is a failed audit, not a clean one.
	}
	// Both exit non-zero whenever any advisory exists, so the exit status says
	// nothing; only a report that could not be produced at all -- the registry
	// down, a broken lockfile, a tool that would not start -- is an error, and
	// that must fail, not pass.
	if (!read) {
		process.stderr.write(`${result.error?.message ?? ''}${result.stderr ?? ''}${stdout}\n`);
		throw new Error(`${tool} audit produced no report in ${cwd}`);
	}
	return advisories;
}

/** The commit to compare against: '' for none, or a commit id. */
function baseline() {
	if ('AUDIT_BASE' in process.env) {
		const base = process.env.AUDIT_BASE.trim();
		if (base) git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
		return base;
	}
	// In CI the baseline comes from scripts/audit-baseline.sh, always, even
	// when it is empty. Unset there means the step lost it -- a rename, a
	// dropped `env:` -- and the parent is the comparison that let a push of
	// several commits through, so refuse rather than fall back to it.
	if (process.env.GITHUB_ACTIONS === 'true') {
		throw new Error('AUDIT_BASE is not set: in CI it must come from scripts/audit-baseline.sh');
	}
	try {
		return git('rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}');
	} catch {
		if (git('rev-parse', '--is-shallow-repository') === 'true') {
			throw new Error("HEAD's parent is not in this shallow clone: check out with more history");
		}
		return ''; // A root commit: there is nothing to compare against.
	}
}

/** The baseline's high and critical advisories, or null if it has no project. */
function auditBaseline(base) {
	const dir = mkdtempSync(path.join(tmpdir(), 'audit-baseline-'));
	try {
		git('worktree', 'add', '--detach', '--quiet', dir, base);
		try {
			const project = path.join(dir, options.dir);
			return existsSync(path.join(project, lockfile)) ? audit(project, dir) : null;
		} finally {
			git('worktree', 'remove', '--force', dir);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Text for a workflow command, which would read `%`, CR and LF as its own. */
const escape = (text) =>
	String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const describe = (a) => {
	// A production path first, when there is one: it is the one that ships.
	const [first, ...rest] = [...a.prodPaths, ...[...a.paths].filter((p) => !a.prodPaths.has(p))];
	const via = rest.length ? `${first} and ${rest.length} more` : first;
	return `${a.id} (${a.severity}) ${a.module}: ${a.title}. Via ${via}`;
};

try {
	if (refused.length > 0) {
		throw new Error(
			`refusing ${refused.join(' ')}: only ${allowed} may be passed to ${tool} audit`,
		);
	}
	const root = git('rev-parse', '--show-toplevel');
	const head = audit(path.resolve(root, options.dir), root);
	const base = baseline();
	let parent = new Map();
	let note = '';
	if (!base) {
		note = ' (no baseline commit: every advisory counts as new)';
	} else {
		const audited = auditBaseline(base);
		if (audited) parent = audited;
		else note = ` (${options.dir} is not in ${base.slice(0, 12)}: every advisory counts as new)`;
	}

	const added = [];
	const existing = [];
	for (const [id, advisory] of head) {
		const before = parent.get(id);
		if (!before) added.push([advisory, '']);
		else if (advisory.prod && !before.prod) {
			added.push([
				advisory,
				' -- the baseline had it only in devDependencies; it now reaches production dependencies',
			]);
		} else existing.push(advisory);
	}

	for (const advisory of existing) {
		console.log(
			`::warning title=Existing advisory::${escape(describe(advisory))} -- already on the baseline commit, so not failing this run`,
		);
	}
	for (const [advisory, why] of added) {
		console.log(`::error title=New advisory::${escape(describe(advisory) + why)}`);
	}
	// Every path, for whoever has to trace one. Annotations show only the first.
	for (const [, advisory] of head) {
		for (const dependencyPath of [...advisory.paths].sort()) {
			const scope = advisory.prodPaths.has(dependencyPath) ? '' : ' (dev)';
			console.log(escape(`  ${advisory.id} ${dependencyPath}${scope}`));
		}
	}
	const against = base ? ` against ${base.slice(0, 12)}` : '';
	console.log(
		`${options.dir === '.' ? '' : `${options.dir}: `}${added.length} new and ${existing.length} existing high or critical advisor${added.length + existing.length === 1 ? 'y' : 'ies'}${against}${note}`,
	);
	process.exitCode = added.length > 0 ? 1 : 0;
} catch (error) {
	// Every failure here fails the audit: a report that could not be produced
	// proves nothing about the lockfile.
	console.log(`::error title=Audit failed::${escape(error.message)}`);
	process.exitCode = 1;
}
