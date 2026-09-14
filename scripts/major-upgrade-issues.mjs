#!/usr/bin/env node
// Keeps one open GitHub issue per available major upgrade.
//
//   pnpm outdated --format json > outdated.json
//   node scripts/major-upgrade-issues.mjs outdated.json [--dry-run]
//
// Dependabot is configured to ignore majors for npm, and has to be: it
// proposes only a package's newest version, so a pending major would take the
// place of the minor and patch updates that auto-merge, and each held major
// would also occupy one of its five open-PR slots. This is how majors are
// noticed instead — an issue to act on, not a PR that blocks the others.
//
// Packages Dependabot groups together (.github/dependabot.yml) share one issue,
// since they upgrade together. An issue's body is refreshed when a newer major
// appears, and it is closed once nothing in it is behind a major any more.
// Issues are matched by a marker comment in the body, and a title edited by
// hand is kept until a newer major changes the issue.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse } from 'yaml';

const LABEL = 'major-upgrade';

// Packages whose major is deliberately not the latest, with why. Listed here
// rather than hidden, so the reason is next to the exclusion.
const SKIP = {
	'@types/node':
		'tracks the Node major the Docker image ships (node:26-alpine), not the newest Node release',
};

const [outdatedPath, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (!outdatedPath) {
	console.error('usage: major-upgrade-issues.mjs <outdated.json> [--dry-run]');
	process.exit(2);
}

const major = (version) => Number(String(version).split('.')[0]);

/** Group name → wildcard patterns, from the npm entry in dependabot.yml. */
function dependabotGroups() {
	const config = parse(readFileSync('.github/dependabot.yml', 'utf-8'));
	const npm = config.updates.find((u) => u['package-ecosystem'] === 'npm');
	return Object.entries(npm?.groups ?? {}).map(([name, group]) => ({
		name,
		patterns: group.patterns.map(
			(p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
		),
	}));
}

/** Upgrades pending, keyed by Dependabot group or package name. */
function pendingUpgrades(outdated, groups) {
	const pending = new Map();
	for (const [name, info] of Object.entries(outdated)) {
		if (SKIP[name] || !info.current || !info.latest) continue;
		if (!(major(info.latest) > major(info.current))) continue;
		const key = groups.find((g) => g.patterns.some((re) => re.test(name)))?.name ?? name;
		const entry = pending.get(key) ?? [];
		entry.push({ name, current: info.current, latest: info.latest });
		pending.set(key, entry);
	}
	return pending;
}

function issueFor(key, packages) {
	const from = Math.min(...packages.map((p) => major(p.current)));
	const to = Math.max(...packages.map((p) => major(p.latest)));
	// A group's name is a family (the "vite" group holds vitest), not a package,
	// so name what's actually moving.
	const names = packages.map((p) => p.name).sort();
	const subject =
		names.length === 1 && names[0] === key ? key : `${names.join(', ')} (${key} group)`;
	const title = `Major upgrade available: ${subject} ${from} → ${to}`;
	const rows = packages
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(
			(p) =>
				`| [\`${p.name}\`](https://www.npmjs.com/package/${p.name}?activeTab=versions) | ${p.current} | ${p.latest} |`,
		)
		.join('\n');
	const body = `<!-- ${LABEL}:${key} -->
A new major version is out. Dependabot does not propose npm majors here (see
\`.github/dependabot.yml\`), so this issue stands in for the PR.

| Package | Locked | Latest |
|---|---|---|
${rows}

Read the release notes for breaking changes (and check the GitHub Security tab
for advisories against the version you'd land on), upgrade on a branch, and let
CI judge it. This issue closes itself once the lockfile is on the latest major;
the weekly check (\`.github/workflows/upgrade-check.yml\`) keeps it current until
then. "Latest" respects pnpm's 24h \`minimumReleaseAge\`, so it may trail npm by
a day.`;
	return { title, body };
}

// GitHub may hand a body back with CRLF line endings or trimmed, which must not
// count as a change or every run would rewrite every issue.
const normalized = (text) => text.replace(/\r\n/g, '\n').trim();

function gh(args) {
	return execFileSync('gh', args, { encoding: 'utf-8' });
}

const report = readFileSync(outdatedPath, 'utf-8').trim();
// `pnpm outdated --format json` prints `{}` when nothing is outdated. An empty
// or non-object report means the step broke (its exit status is useless: it
// exits 1 whenever anything is outdated), and must not read as "no majors",
// which would close every open issue.
const outdated = JSON.parse(report);
if (typeof outdated !== 'object' || outdated === null || Array.isArray(outdated)) {
	throw new Error(`unexpected pnpm outdated report: ${report.slice(0, 200)}`);
}
const pending = pendingUpgrades(outdated, dependabotGroups());

const open = dryRun
	? []
	: JSON.parse(
			gh([
				'issue',
				'list',
				'--label',
				LABEL,
				'--state',
				'open',
				'--limit',
				'200',
				'--json',
				'number,title,body',
			]),
		);
const byKey = new Map();
for (const issue of open) {
	const key = issue.body.match(new RegExp(`<!-- ${LABEL}:(.+?) -->`))?.[1];
	if (key) byKey.set(key, issue);
}

if (!dryRun) {
	gh([
		'label',
		'create',
		LABEL,
		'--force',
		'--color',
		'd4c5f9',
		'--description',
		'A major version upgrade is available',
	]);
}

for (const [key, packages] of pending) {
	const { title, body } = issueFor(key, packages);
	const existing = byKey.get(key);
	if (dryRun) {
		console.log(`${existing ? 'update' : 'open'}: ${title}\n${body}\n`);
		continue;
	}
	if (!existing) {
		gh(['issue', 'create', '--title', title, '--body', body, '--label', LABEL]);
		console.log(`Opened: ${title}`);
	} else if (normalized(existing.body) !== normalized(body)) {
		// The title is only rewritten along with a body change (a newer major),
		// so a title someone edited stays put until there is news.
		gh(['issue', 'edit', String(existing.number), '--title', title, '--body', body]);
		console.log(`Updated #${existing.number}: ${title}`);
	} else {
		console.log(`Unchanged #${existing.number}: ${existing.title}`);
	}
}

for (const [key, issue] of byKey) {
	if (pending.has(key)) continue;
	gh([
		'issue',
		'close',
		String(issue.number),
		'--comment',
		'Closing: nothing here is behind a major version any more.',
	]);
	console.log(`Closed #${issue.number}: ${issue.title}`);
}

for (const [name, reason] of Object.entries(SKIP)) {
	const info = outdated[name];
	if (info && major(info.latest) > major(info.current)) {
		console.log(`Skipped ${name} ${info.current} → ${info.latest}: ${reason}`);
	}
}
