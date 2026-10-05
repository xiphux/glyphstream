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
 * HEAD's first parent; set but empty, there is none and every advisory counts
 * as new.
 *
 * Advisories are compared by id, not by the dependency paths that reach
 * them. Matching paths too looked stricter and was not: a routine update that
 * reshuffles the tree around a package already flagged -- eslint-plugin-n
 * 18.4.0 added seven paths to a brace-expansion advisory glyphstream already
 * had -- would fail, which is the blocking this replaced. Every path is still
 * printed. But an advisory already on the baseline cannot vouch for more
 * than it covered there, so it still counts as new when HEAD has it:
 *
 * - in a package it did not reach on the baseline;
 * - in a version of that package older than every version the baseline had
 *   -- swapping a fixed copy for an older vulnerable one brought in by
 *   something else. Fixes move versions up, never down, and pnpm does not
 *   dedupe: a dependent moving to a newer, still-affected version leaves the
 *   old one for the rest, and failing that would block the partial fix (as
 *   it would for an advisory with no fixed version at all). A newer
 *   vulnerable copy brought in by a new dependency is the case this lets
 *   through;
 * - in more production copies of the package than the baseline had --
 *   including any, when the baseline had it only in devDependencies, so the
 *   dev tree cannot vouch for what ships. Production is counted strictly, so
 *   a partial fix that splits a production copy in two fails too; `pnpm
 *   dedupe`, an override, or an ignore entry with its reason resolves it.
 *
 * npm's report gives no versions, so in --npm mode only a package the
 * advisory did not reach before counts.
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
 * The only other arguments accepted, and passed to both audits, are `--prod`
 * and `--omit=dev`: each leaves out what does not ship, which the caller can
 * decide. Anything else is refused, since the rest of what the tools accept
 * narrows the report or makes a failure read as clean --
 * `--ignore-registry-errors` turns an unreachable registry into an empty
 * report, `--audit-level` and `--no-optional` drop findings, `--registry`
 * moves the question to another server.
 *
 * What the audits report is pinned on the command line, ahead of those
 * arguments, because configuration can narrow it without saying so:
 * `auditLevel: critical` in pnpm-workspace.yaml empties pnpm's JSON of every
 * high advisory, `optional: false` there drops optional dependencies from it,
 * `omit=optional` or `omit=peer` in an .npmrc does the same to npm's, and a
 * `registry=` line sends either to a server whose empty answer reads as
 * clean. The severity this cares about is filtered here, not by the tool.
 * (Each side runs the pnpm its own `packageManager` names, so a change that
 * bumps pnpm compares two versions' reports.)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SEVERE = new Set(['high', 'critical']);

const REGISTRY = '--registry=https://registry.npmjs.org/';
const ALLOWED = new Set(['--prod', '--omit=dev']);

const options = { npm: false, dir: '.' };
const auditArgs = [];
const refused = [];
for (const arg of process.argv.slice(2)) {
	if (arg === '--npm') options.npm = true;
	else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
	else if (ALLOWED.has(arg)) auditArgs.push(arg);
	else refused.push(arg);
}
const tool = options.npm ? 'npm' : 'pnpm';
const lockfile = options.npm ? 'package-lock.json' : 'pnpm-lock.yaml';
const pinned = options.npm
	? ['--include=optional', '--include=peer', REGISTRY]
	: ['--audit-level=low', '--optional', REGISTRY];

// GIT_LFS_SKIP_SMUDGE: the audit needs the lockfile, not the baseline's LFS
// files, and checkouts here drop their credentials, so an LFS download
// during `git worktree add` would fail the run.
const git = (...args) =>
	execFileSync('git', args, {
		encoding: 'utf8',
		env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
	}).trim();

/**
 * Adds one finding to `advisories`, keyed by advisory id, with the copies of
 * the package it reaches: `copies` maps a package to its versions, all and
 * production.
 */
function record(advisories, { id, severity, module, version, title, paths, prod }) {
	const entry = advisories.get(id) ?? {
		id,
		severity,
		module,
		title,
		paths: new Set(),
		prodPaths: new Set(),
		copies: new Map(),
	};
	// A finding reported with no path still has something to print.
	for (const dependencyPath of paths.length ? paths : ['(no path reported)']) {
		entry.paths.add(dependencyPath);
		if (prod) entry.prodPaths.add(dependencyPath);
	}
	const copies = entry.copies.get(module) ?? {
		all: new Set(),
		prod: new Set(),
	};
	copies.all.add(version);
	if (prod) copies.prod.add(version);
	entry.copies.set(module, copies);
	advisories.set(id, entry);
}

/**
 * `pnpm audit --json`: advisories, each with findings that carry their
 * dependency paths and whether they are reached only through devDependencies.
 */
function readPnpm(report, advisories) {
	if (typeof report.advisories !== 'object' || report.advisories === null) return false;
	for (const advisory of Object.values(report.advisories)) {
		if (!SEVERE.has(advisory.severity)) continue;
		for (const finding of advisory.findings) {
			record(advisories, {
				id: advisory.github_advisory_id ?? `npm-${advisory.id}`,
				severity: advisory.severity,
				module: advisory.module_name,
				version: finding.version,
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
 * say which paths are dev-only, so these count as production; with
 * `--omit=dev`, they are.
 */
function readNpm(report, advisories) {
	if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
		return false;
	}
	for (const vulnerability of Object.values(report.vulnerabilities)) {
		for (const via of vulnerability.via) {
			if (typeof via === 'string' || !SEVERE.has(via.severity)) continue;
			record(advisories, {
				id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`,
				severity: via.severity,
				module: via.name,
				// No versions in npm's report: one copy per package, as far as this
				// can tell.
				version: '',
				title: via.title,
				paths: vulnerability.nodes,
				prod: true,
			});
		}
	}
	return true;
}

/** High and critical advisories, by id, with the paths that reach them. */
function audit(cwd) {
	const result = spawnSync(tool, ['audit', '--json', ...pinned, ...auditArgs], {
		cwd,
		encoding: 'utf8',
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
		// Fall through: an unparseable report is a failed audit, not a clean one.
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

/**
 * Whether version `a` is older than `b`, by semver precedence. One that is not
 * semver counts as older: it cannot be shown to be the newer copy a fix
 * arrives as, so it is not given that benefit.
 */
function older(a, b) {
	const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v);
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return true;
	for (let i = 1; i <= 3; i++) {
		if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
	}
	if (!x[4] || !y[4]) return Boolean(x[4]) && !y[4]; // 1.0.0-rc < 1.0.0
	const xs = x[4].split('.');
	const ys = y[4].split('.');
	for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
		if (xs[i] === undefined) return true;
		if (ys[i] === undefined) return false;
		if (xs[i] === ys[i]) continue;
		const [xn, yn] = [/^\d+$/.test(xs[i]), /^\d+$/.test(ys[i])];
		if (xn && yn) return Number(xs[i]) < Number(ys[i]);
		if (xn !== yn) return xn; // numeric identifiers sort first
		return xs[i] < ys[i];
	}
	return false;
}

/**
 * Why `advisory`, which the baseline also had as `before`, still counts as
 * new -- one reason per package -- or nothing, if it does not.
 */
function stillNew(advisory, before) {
	const reasons = [];
	for (const [module, now] of advisory.copies) {
		const then = before.copies.get(module);
		const label = (versions) =>
			[...versions].map((v) => (v ? `${module}@${v}` : module)).join(', ');
		if (!then) {
			reasons.push(`it now reaches ${module}, which it did not on the baseline`);
			continue;
		}
		const downgrades = [...now.all].filter(
			(v) => !then.all.has(v) && [...then.all].every((t) => older(v, t)),
		);
		if (downgrades.length > 0) {
			reasons.push(
				`it now reaches ${label(downgrades)}, older than any copy the baseline had (${label(then.all)})`,
			);
		}
		if (now.prod.size > then.prod.size) {
			reasons.push(
				then.prod.size === 0
					? `the baseline had ${module} only in devDependencies; it now reaches production dependencies (${label(now.prod)})`
					: `it now reaches more production copies of ${module} than the baseline did: ${label(now.prod)}, was ${label(then.prod)}`,
			);
		}
	}
	return reasons;
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
			return existsSync(path.join(project, lockfile)) ? audit(project) : null;
		} finally {
			git('worktree', 'remove', '--force', dir);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const describe = (a) => {
	// A production path first, when there is one: it is the one that ships.
	const [first, ...rest] = [...a.prodPaths, ...[...a.paths].filter((p) => !a.prodPaths.has(p))];
	const via = rest.length ? `${first} and ${rest.length} more` : first;
	return `${a.id} (${a.severity}) ${a.module}: ${a.title}. Via ${via}`;
};

try {
	if (refused.length > 0) {
		throw new Error(
			`refusing ${refused.join(' ')}: only ${[...ALLOWED].join(' and ')} may be passed to the audits`,
		);
	}
	const root = git('rev-parse', '--show-toplevel');
	const head = audit(path.resolve(root, options.dir));
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
		const reasons = before ? stillNew(advisory, before) : [];
		if (!before) added.push([advisory, '']);
		else if (reasons.length > 0) {
			added.push([advisory, ` -- already on the baseline, but ${reasons.join('; ')}`]);
		} else existing.push(advisory);
	}

	for (const advisory of existing) {
		console.log(
			`::warning title=Existing advisory::${describe(advisory)} -- already on the baseline commit, so not failing this run`,
		);
	}
	for (const [advisory, why] of added) {
		console.log(`::error title=New advisory::${describe(advisory)}${why}`);
	}
	// Every path, for whoever has to trace one. Annotations show only the first.
	for (const [, advisory] of head) {
		for (const dependencyPath of [...advisory.paths].sort()) {
			const scope = advisory.prodPaths.has(dependencyPath) ? '' : ' (dev)';
			console.log(`  ${advisory.id} ${dependencyPath}${scope}`);
		}
	}
	const against = base ? ` against ${base.slice(0, 12)}` : '';
	console.log(
		`${options.dir === '.' ? '' : `${options.dir}: `}${added.length} new and ${existing.length} existing high or critical advisor${added.length + existing.length === 1 ? 'y' : 'ies'}${against}${note}`,
	);
	process.exitCode = added.length > 0 ? 1 : 0;
} catch (error) {
	// Every failure here fails the gate: a report that could not be produced
	// proves nothing about the lockfile.
	console.log(`::error title=Audit failed::${error.message}`);
	process.exitCode = 1;
}
