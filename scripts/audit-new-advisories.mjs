#!/usr/bin/env node
/**
 * Fail on the high and critical advisories this commit adds, not on every
 * one in the lockfile.
 *
 * `pnpm audit --audit-level=high` on its own fails whenever any such advisory
 * exists, so one published against a package already locked -- with or
 * without a fix -- failed every pull request until someone dealt with it,
 * whatever the pull request changed. Worse, two Renovate PRs that each fixed
 * one advisory could never merge: each still carried the other's. The
 * question a pull request can answer is whether it makes things worse, so
 * that is what this asks.
 *
 * It audits HEAD and HEAD's first parent and fails only on findings HEAD has
 * that the parent does not. On a pull request, actions/checkout checks out
 * GitHub's merge commit, whose first parent is the target branch, so the
 * parent is "the base without this change"; on a push, it is the previous
 * commit. The checkout therefore needs `fetch-depth: 2`.
 *
 * Advisories are compared by id, not by the dependency paths that reach
 * them. Matching paths too looked stricter and was not: a routine update that
 * reshuffles the tree around a package already flagged -- eslint-plugin-n
 * 18.4.0 added seven paths to a brace-expansion advisory glyphstream already
 * had -- would fail, which is the blocking this replaced. Every path is still
 * printed.
 *
 * Findings already on the parent are printed as warnings and do not fail the
 * run. They stay visible there, as Dependabot alerts, and as Renovate's
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
 *                 (default: the root). A project the parent does not have
 *                 yet counts as entirely new.
 *
 * Anything else is passed to both audits, e.g. `--prod` or `--omit=dev`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SEVERE = new Set(['high', 'critical']);

const options = { npm: false, dir: '.' };
const auditArgs = [];
for (const arg of process.argv.slice(2)) {
	if (arg === '--npm') options.npm = true;
	else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
	else auditArgs.push(arg);
}
const tool = options.npm ? 'npm' : 'pnpm';
const lockfile = options.npm ? 'package-lock.json' : 'pnpm-lock.yaml';

// GIT_LFS_SKIP_SMUDGE: the audit needs the lockfile, not the parent's LFS
// files, and checkouts here drop their credentials, so an LFS download
// during `git worktree add` would fail the run.
const git = (...args) =>
	execFileSync('git', args, {
		encoding: 'utf8',
		env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
	}).trim();

/** Adds one advisory's paths to `advisories`, keyed by id. */
function record(advisories, { id, severity, module, title, paths }) {
	const entry = advisories.get(id) ?? {
		id,
		severity,
		module,
		title,
		paths: new Set(),
	};
	for (const dependencyPath of paths) entry.paths.add(dependencyPath);
	advisories.set(id, entry);
}

/** `pnpm audit --json`: advisories, each with its findings' paths. */
function readPnpm(report, advisories) {
	if (typeof report.advisories !== 'object') return false;
	for (const advisory of Object.values(report.advisories)) {
		if (!SEVERE.has(advisory.severity)) continue;
		record(advisories, {
			id: advisory.github_advisory_id,
			severity: advisory.severity,
			module: advisory.module_name,
			title: advisory.title,
			paths: advisory.findings.flatMap((finding) => finding.paths),
		});
	}
	return true;
}

/**
 * `npm audit --json`: vulnerable packages, each listing the advisories that
 * make it so under `via`. A package's own severity is the worst of those, so
 * it is each advisory's that counts. `via` also names other packages, by
 * string, when the problem is in a dependency; those are listed again under
 * their own name, so only the advisory objects are read.
 */
function readNpm(report, advisories) {
	if (typeof report.vulnerabilities !== 'object') return false;
	for (const vulnerability of Object.values(report.vulnerabilities)) {
		for (const via of vulnerability.via) {
			if (typeof via === 'string' || !SEVERE.has(via.severity)) continue;
			record(advisories, {
				id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`,
				severity: via.severity,
				module: via.name,
				title: via.title,
				paths: vulnerability.nodes,
			});
		}
	}
	return true;
}

/** High and critical advisories, by id, with the paths that reach them. */
function audit(cwd) {
	const result = spawnSync(tool, ['audit', '--json', ...auditArgs], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	const advisories = new Map();
	let read = false;
	try {
		// From the first brace: pnpm prints warnings to stdout ahead of the JSON,
		// such as an engines mismatch on the Node version.
		const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
		read = (options.npm ? readNpm : readPnpm)(report, advisories);
	} catch {
		// Fall through: an unparseable report is a failed audit, not a clean one.
	}
	// Both exit non-zero whenever any advisory exists, so the exit status says
	// nothing; only a report that could not be produced at all -- the registry
	// down, a broken lockfile -- is an error, and that must fail, not pass.
	if (!read) {
		process.stderr.write(`${result.stderr}${result.stdout}`);
		throw new Error(`${tool} audit produced no report in ${cwd}`);
	}
	return advisories;
}

/** The first parent, checked out where it can be audited, or null. */
function checkoutParent() {
	try {
		git('rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}');
	} catch {
		if (git('rev-parse', '--is-shallow-repository') === 'true') {
			throw new Error(
				"HEAD's parent is not in this shallow clone: check out with `fetch-depth: 2`",
			);
		}
		return null; // A root commit: there is nothing to compare against.
	}
	const dir = mkdtempSync(path.join(tmpdir(), 'audit-parent-'));
	git('worktree', 'add', '--detach', '--quiet', dir, 'HEAD^1');
	return dir;
}

const describe = (a) => {
	const [first, ...rest] = [...a.paths].sort();
	const via = rest.length ? `${first} and ${rest.length} more` : first;
	return `${a.id} (${a.severity}) ${a.module}: ${a.title}. Via ${via}`;
};

try {
	const head = audit(path.resolve(options.dir));
	const parentDir = checkoutParent();
	let parent = new Map();
	let note = parentDir ? '' : ' (no parent commit: every finding counts as new)';
	if (parentDir) {
		try {
			const project = path.join(parentDir, options.dir);
			if (existsSync(path.join(project, lockfile))) parent = audit(project);
			else note = ` (${options.dir} is new in this commit: every finding counts as new)`;
		} finally {
			git('worktree', 'remove', '--force', parentDir);
			rmSync(parentDir, { recursive: true, force: true });
		}
	}

	const added = [...head].filter(([key]) => !parent.has(key));
	const existing = [...head].filter(([key]) => parent.has(key));

	for (const [, advisory] of existing) {
		console.log(
			`::warning title=Existing advisory::${describe(advisory)} -- already on the parent commit, so not failing this run`,
		);
	}
	for (const [, advisory] of added) {
		console.log(`::error title=New advisory::${describe(advisory)}`);
	}
	// Every path, for whoever has to trace one. Annotations show only the first.
	for (const [, advisory] of head) {
		for (const dependencyPath of [...advisory.paths].sort()) {
			console.log(`  ${advisory.id} ${dependencyPath}`);
		}
	}
	console.log(
		`${options.dir === '.' ? '' : `${options.dir}: `}${added.length} new and ${existing.length} existing high or critical advisor${added.length + existing.length === 1 ? 'y' : 'ies'}${note}`,
	);
	process.exitCode = added.length > 0 ? 1 : 0;
} catch (error) {
	// Every failure here fails the gate: a report that could not be produced
	// proves nothing about the lockfile.
	console.log(`::error title=Audit failed::${error.message}`);
	process.exitCode = 1;
}
