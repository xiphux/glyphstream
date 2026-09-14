#!/usr/bin/env node
// Keeps one open GitHub issue when either TypeScript compiler has a release
// newer than the lockfile.
//
//   node scripts/typescript-release-issue.mjs [--dry-run]
//
// Neither Dependabot nor the major-upgrade check sees these: both compilers are
// npm aliases (`typescript` -> @typescript/typescript6 for the tooling API,
// `@typescript/native` -> typescript 7, see CLAUDE.md's `tsc` sharp edge), and
// dependabot-core and `pnpm outdated` both skip aliased dependencies. Upgrades
// are manual, which is fine, but nothing said when one was due — and 7.1 is the
// release CLAUDE.md names as the point to collapse the aliases, once
// svelte-check, svelte2tsx and typescript-eslint run on its API.
//
// A release younger than pnpm's 24h `minimumReleaseAge` isn't reported yet: the
// lockfile couldn't take it. One open issue at most — a run with news rewrites
// its body, a run with nothing new leaves it alone, and it closes once both
// compilers are current.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse } from 'yaml';

const MARKER = '<!-- typescript-release -->';
const TITLE = 'TypeScript release available';
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

// package.json alias -> the npm package it installs.
const COMPILERS = {
	typescript: '@typescript/typescript6',
	'@typescript/native': 'typescript',
};

const dryRun = process.argv.includes('--dry-run');

function run(cmd, args) {
	return execFileSync(cmd, args, { encoding: 'utf-8' });
}

/** The version the root importer locks for an alias, e.g. `7.0.2`. */
function lockedVersion(lock, alias, pkg) {
	const importer = lock.importers?.['.'] ?? {};
	const entry = importer.dependencies?.[alias] ?? importer.devDependencies?.[alias];
	// An aliased entry's version is `<package>@<version>`.
	const match = entry && String(entry.version).match(/^(.+)@([^@]+)$/);
	if (!match || match[1] !== pkg) {
		throw new Error(`pnpm-lock.yaml has no ${alias} -> ${pkg} entry (got ${entry?.version})`);
	}
	return match[2];
}

/** npm's `latest` for a package, if it's old enough for pnpm to install. */
function installableLatest(pkg) {
	const latest = JSON.parse(run('npm', ['view', pkg, 'version', '--json']));
	const times = JSON.parse(run('npm', ['view', pkg, 'time', '--json']));
	const age = Date.now() - Date.parse(times[latest]);
	return { latest, ready: age >= MIN_AGE_MS };
}

const lock = parse(readFileSync('pnpm-lock.yaml', 'utf-8'));
const lines = [];
for (const [alias, pkg] of Object.entries(COMPILERS)) {
	const locked = lockedVersion(lock, alias, pkg);
	const { latest, ready } = installableLatest(pkg);
	console.log(
		`${alias} (npm ${pkg}): locked ${locked}, latest ${latest}${ready ? '' : ' (under 24h old)'}`,
	);
	if (ready && latest !== locked) {
		lines.push(
			`- \`${alias}\` (npm \`${pkg}\`): ${locked} in the lockfile, ${latest} is npm's latest`,
		);
	}
}

const existing = dryRun
	? null
	: (JSON.parse(
			run('gh', [
				'issue',
				'list',
				'--state',
				'open',
				'--search',
				`"${TITLE}" in:title`,
				'--json',
				'number,body',
			]),
		).find((i) => i.body.includes(MARKER)) ?? null);

if (lines.length === 0) {
	console.log('Both compilers are current.');
	if (existing) {
		run('gh', [
			'issue',
			'close',
			String(existing.number),
			'--comment',
			'Closing: both compilers are current.',
		]);
		console.log(`Closed #${existing.number}`);
	}
	process.exit(0);
}

const body = `${MARKER}
Dependabot doesn't propose these (they're npm aliases), so this check reports them.

${lines.join('\n')}

Upgrade them by hand. If \`@typescript/native\` (npm \`typescript\`) has reached
7.1, check whether svelte-check, svelte2tsx and typescript-eslint run on its
API: CLAUDE.md's \`tsc\` sharp edge describes collapsing the aliases back to a
plain \`typescript\` dependency at that point.`;

if (dryRun) {
	console.log(`${TITLE}\n${body}`);
} else if (!existing) {
	run('gh', ['issue', 'create', '--title', TITLE, '--body', body]);
	console.log(`Opened: ${TITLE}`);
} else if (existing.body.replace(/\r\n/g, '\n').trim() !== body.trim()) {
	run('gh', ['issue', 'edit', String(existing.number), '--body', body]);
	console.log(`Updated #${existing.number}`);
} else {
	console.log(`Unchanged #${existing.number}`);
}
