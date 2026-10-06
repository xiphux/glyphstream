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
 * - at a version lower than the one the baseline had on the same dependency
 *   path -- an override or a pin that moved a copy down. Fixes move versions
 *   up, never down;
 * - in a version of that package older than every version the baseline had,
 *   or, in production, older than every production version it had --
 *   swapping a fixed copy for an older vulnerable one that something else
 *   brought in, which the dev tree cannot vouch for either;
 * - in more production copies of the package than the baseline had --
 *   including any, when the baseline had it only in devDependencies, so the
 *   dev tree cannot vouch for what ships. Production is counted strictly, so
 *   a partial fix that splits a production copy in two fails too; `pnpm
 *   dedupe`, an override, or an ignore entry with its reason resolves it.
 *
 * What these let through: a copy on a new path that is not older than every
 * copy the baseline had -- a newer one, one between two the baseline had, or
 * one it already had -- in devDependencies, or in production in place of
 * one that went away. pnpm does not dedupe: a dependent moving to a newer,
 * still-affected version leaves the old one for the rest, and failing that
 * would block the partial fix (as it would for an advisory with no fixed
 * version at all). npm's copies are read from package-lock.json, by the
 * same rules.
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
 * npm -- which the caller can decide. Anything else is refused, since the
 * rest of what the tools accept narrows the report or makes a failure read
 * as clean: `--ignore-registry-errors` turns an unreachable registry into an
 * empty report, `--audit-level` and `--no-optional` drop findings,
 * `--registry` moves the question to another server.
 *
 * What the audits report is pinned on the command line, ahead of those
 * arguments, because configuration can narrow it without saying so, and
 * each reads as a clean report:
 *
 * - pnpm: `auditLevel: critical` in pnpm-workspace.yaml empties the JSON of
 *   every high advisory and `optional: false` drops optional dependencies
 *   (`--audit-level=low --optional`); a .pnpmfile.cjs `updateConfig` hook
 *   can rewrite any of it, the registry and the ignore list included
 *   (`--ignore-pnpmfile`).
 * - npm: `omit=` in an .npmrc drops dev, optional or peer dependencies
 *   (`--include=...`, dev unless `--omit=dev` is asked for -- npm's
 *   `--include` wins over `--omit`), `offline=true` answers with an empty
 *   report and `legacy-peer-deps=true` drops peers (`--offline=false
 *   --legacy-peer-deps=false`).
 * - Both: a `registry=` line sends the audit to a server whose empty answer
 *   reads as clean (`--registry`), and a proxy with `strict-ssl=false` can
 *   stand in for the registry (`strict-ssl=true`: a proxy that cannot
 *   present the registry's certificate fails the audit, which fails here).
 *
 * The same settings in the environment -- `npm_config_*`, `pnpm_config_*`,
 * and NODE_ENV=production, which npm reads as omitting dev -- are dropped
 * from the audits' environment. The severity this cares about is filtered
 * here, not by the tool. (Each side runs the pnpm its own `packageManager`
 * names, so a change that bumps pnpm compares two versions' reports.)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SEVERE = new Set(['high', 'critical']);

const REGISTRY = '--registry=https://registry.npmjs.org/';

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
const pinned = options.npm
	? [
			'--include=optional',
			'--include=peer',
			...(auditArgs.includes('--omit=dev') ? [] : ['--include=dev']),
			REGISTRY,
			'--offline=false',
			'--legacy-peer-deps=false',
			'--strict-ssl=true',
		]
	: ['--audit-level=low', '--optional', REGISTRY, '--ignore-pnpmfile', '--config.strict-ssl=true'];
// The audits' environment, without the settings that would narrow them.
const auditEnv = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !/^(npm_config_|pnpm_config_|node_env$)/i.test(key),
	),
);

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
 * production, and `at` maps each dependency path to the versions on it.
 */
function record(advisories, { id, severity, module, version, title, paths, prod }) {
	if (typeof version !== 'string' || version === '') {
		throw new Error(`${tool} reported ${id} in ${module} with no version`);
	}
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
	for (const dependencyPath of paths?.length ? paths : ['(no path reported)']) {
		entry.paths.add(dependencyPath);
		if (prod) entry.prodPaths.add(dependencyPath);
	}
	const copies = entry.copies.get(module) ?? {
		all: new Set(),
		prod: new Set(),
		at: new Map(),
	};
	copies.all.add(version);
	if (prod) copies.prod.add(version);
	for (const dependencyPath of paths ?? []) {
		const versions = copies.at.get(dependencyPath) ?? new Set();
		versions.add(version);
		copies.at.set(dependencyPath, versions);
	}
	entry.copies.set(module, copies);
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
 * their own name, so only the advisory objects are read. The report gives
 * each copy's place in node_modules (`nodes`) but not its version or whether
 * it is a dev dependency, so both are read from the package-lock.json beside
 * it; a node it does not list fails the audit.
 */
function readNpm(report, advisories, cwd) {
	if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
		return false;
	}
	const lock = JSON.parse(readFileSync(path.join(cwd, lockfile), 'utf8'));
	for (const vulnerability of Object.values(report.vulnerabilities)) {
		for (const via of vulnerability.via) {
			if (typeof via === 'string' || !severe(via.severity)) continue;
			for (const node of vulnerability.nodes) {
				const locked = lock.packages?.[node];
				if (!locked) throw new Error(`${node} is not in ${lockfile}`);
				record(advisories, {
					id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`,
					severity: via.severity,
					module: via.name,
					version: locked.version,
					title: via.title,
					paths: [node],
					prod: locked.dev !== true,
				});
			}
		}
	}
	return true;
}

/** High and critical advisories, by id, with the paths that reach them. */
function audit(cwd) {
	const result = spawnSync(tool, ['audit', '--json', ...pinned, ...auditArgs], {
		cwd,
		encoding: 'utf8',
		env: auditEnv,
		maxBuffer: 64 * 1024 * 1024,
	});
	const stdout = result.stdout ?? '';
	const advisories = new Map();
	let read = false;
	let why = '';
	try {
		// From the first brace: pnpm prints warnings to stdout ahead of the JSON,
		// such as an engines mismatch on the Node version.
		const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
		read = (options.npm ? readNpm : readPnpm)(report, advisories, cwd);
	} catch (error) {
		// Fall through: an unreadable report is a failed audit, not a clean one.
		why = `: ${error.message}`;
	}
	// Both exit non-zero whenever any advisory exists, so the exit status says
	// nothing; only a report that could not be produced at all -- the registry
	// down, a broken lockfile, a tool that would not start -- is an error, and
	// that must fail, not pass.
	if (!read) {
		process.stderr.write(`${result.error?.message ?? ''}${result.stderr ?? ''}${stdout}\n`);
		throw new Error(`${tool} audit produced no report in ${cwd}${why}`);
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
	// Versions in `now` older than every one in `then`, when `then` has any.
	const below = (now, then) =>
		then.size === 0
			? []
			: [...now].filter((v) => !then.has(v) && [...then].every((t) => older(v, t)));
	for (const [module, now] of advisory.copies) {
		const then = before.copies.get(module);
		const label = (versions) => [...versions].map((v) => `${module}@${v}`).join(', ');
		if (!then) {
			reasons.push(`it now reaches ${module}, which it did not on the baseline`);
			continue;
		}
		for (const [dependencyPath, versions] of now.at) {
			const was = then.at.get(dependencyPath);
			const lower = was ? below(versions, was) : [];
			if (lower.length > 0) {
				reasons.push(`${dependencyPath} moved down to ${label(lower)} from ${label(was)}`);
			}
		}
		const downgrades = below(now.all, then.all);
		if (downgrades.length > 0) {
			reasons.push(
				`it now reaches ${label(downgrades)}, older than any copy the baseline had (${label(then.all)})`,
			);
		}
		const prodDowngrades = below(now.prod, then.prod).filter((v) => !downgrades.includes(v));
		if (prodDowngrades.length > 0) {
			reasons.push(
				`it now reaches ${label(prodDowngrades)} in production, older than any production copy the baseline had (${label(then.prod)})`,
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
	// Every failure here fails the gate: a report that could not be produced
	// proves nothing about the lockfile.
	console.log(`::error title=Audit failed::${escape(error.message)}`);
	process.exitCode = 1;
}
