/**
 * CHANGELOG.md as the single source of release notes.
 *
 *   node scripts/changelog.mjs validate
 *   node scripts/changelog.mjs release v0.39.0 [--repo owner/name] [--previous v0.38.3]
 *
 * `validate` checks the file's structure and is run by ci.yml. `release` writes
 * the GitHub release body to stdout and FAILS when the version has no entry,
 * which is what stops a release publishing empty notes.
 *
 * Why this exists: docker.yml used to pass `generate_release_notes: true`, and
 * GitHub's generator lists PULL REQUESTS only. Work here lands as direct commits
 * to main and the only PRs are Renovate bumps, which .github/release.yml
 * excluded by label -- so every candidate was filtered out and 105 of the first
 * 106 releases published a body with an empty "What's Changed". A hand-written
 * changelog is also the only source that can tell a shipped change from one
 * that was fixed again before any release carried it.
 *
 * Plain .mjs importing nothing outside node: builtins, so the release and infra
 * jobs run it straight from a checkout with no pnpm install. It is still
 * type-checked: tsconfig sets `allowJs` + `checkJs`, and the unit test that
 * imports it is inside the program.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** `vX.Y.Z`, with an optional prerelease suffix. */
const VERSION = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const UNRELEASED = 'Unreleased';

/**
 * @typedef {{ heading: string, body: string }} Section
 */

/**
 * Split the file into its `## ` sections, in file order.
 *
 * @param {string} text
 * @returns {Section[]}
 */
export function parseChangelog(text) {
	/** @type {{ heading: string, lines: string[] }[]} */
	const sections = [];
	for (const line of text.split('\n')) {
		// `^##\s` cannot match `### `: the third `#` is not whitespace.
		const heading = /^##\s+(\S.*?)\s*$/.exec(line);
		if (heading) {
			sections.push({ heading: heading[1], lines: [] });
		} else if (sections.length > 0) {
			sections[sections.length - 1].lines.push(line);
		}
	}
	return sections.map(({ heading, lines }) => ({ heading, body: lines.join('\n').trim() }));
}

/**
 * @typedef {{ core: [number, number, number], pre: string[] | null }} VersionKey
 */

/**
 * Sortable key for a `vX.Y.Z` heading, or null if the heading is not a version.
 *
 * The prerelease suffix is KEPT, not discarded. Dropping it made `## v1.0.0`
 * above `## v1.0.0-rc.1` compare equal, so a correctly ordered file was
 * reported as out of order -- while the regex above and the unit tests both
 * advertised that prereleases are supported.
 *
 * @param {string} heading
 * @returns {VersionKey | null}
 */
function versionKey(heading) {
	const match = VERSION.exec(heading);
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] ? match[4].split('.') : null,
	};
}

/**
 * Semver precedence for the dot-separated prerelease identifiers: numeric ones
 * compare numerically, a numeric identifier ranks below an alphanumeric one,
 * the rest compare as ASCII, and when everything else ties the longer list
 * wins.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function comparePrerelease(a, b) {
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
		if (a[i] === b[i]) continue;
		const aNumeric = /^\d+$/.test(a[i]);
		const bNumeric = /^\d+$/.test(b[i]);
		if (aNumeric && bNumeric) return Number(a[i]) - Number(b[i]);
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a[i] < b[i] ? -1 : 1;
	}
	return a.length - b.length;
}

/**
 * @param {VersionKey} a
 * @param {VersionKey} b
 * @returns {number} negative when `a` is the older version
 */
function compareVersions(a, b) {
	for (let i = 0; i < 3; i += 1) {
		if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
	}
	// A release outranks its own prereleases: 1.0.0 is newer than 1.0.0-rc.1.
	if (a.pre === null && b.pre === null) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	return comparePrerelease(a.pre, b.pre);
}

/**
 * Structural problems with the changelog. An empty list means valid.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function validate(text) {
	/** @type {string[]} */
	const problems = [];
	if (!/^#\s+Changelog\s*$/.test(text.split('\n')[0] ?? '')) {
		problems.push('the first line must be "# Changelog"');
	}

	const sections = parseChangelog(text);
	if (sections.length === 0) {
		problems.push('no "## " release sections found');
		return problems;
	}

	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {VersionKey | null} */
	let previousKey = null;

	sections.forEach(({ heading, body }, index) => {
		if (heading === UNRELEASED) {
			// Only ever the top section: an Unreleased below a released version
			// would mean the entries under it had already shipped.
			if (index !== 0) problems.push(`"${UNRELEASED}" must be the first section`);
			return;
		}

		const key = versionKey(heading);
		if (!key) {
			problems.push(`"## ${heading}" is neither "${UNRELEASED}" nor a vX.Y.Z version`);
			return;
		}
		if (seen.has(heading)) problems.push(`"## ${heading}" appears more than once`);
		seen.add(heading);

		// Newest first, so a released section is never appended to the bottom.
		if (previousKey !== null && compareVersions(previousKey, key) <= 0) {
			problems.push(`"## ${heading}" is not below the version above it (newest first)`);
		}
		previousKey = key;

		// The whole point: a released version with nothing under it publishes
		// the empty notes this file exists to prevent.
		if (body === '') problems.push(`"## ${heading}" has no entries`);
	});

	return problems;
}

/**
 * The entries for one version.
 *
 * @param {string} text
 * @param {string} tag e.g. `v0.39.0`
 * @returns {string}
 */
export function sectionFor(text, tag) {
	const section = parseChangelog(text).find((s) => s.heading === tag);
	if (!section) {
		throw new Error(
			`CHANGELOG.md has no "## ${tag}" section. Rename "## ${UNRELEASED}" to "## ${tag}" before tagging.`,
		);
	}
	if (section.body === '') {
		throw new Error(`CHANGELOG.md's "## ${tag}" section is empty.`);
	}
	return section.body;
}

/**
 * Released versions in the changelog, in file order (newest first).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function releasedVersions(text) {
	return parseChangelog(text)
		.map((s) => s.heading)
		.filter((heading) => VERSION.test(heading));
}

/**
 * The version released before `tag`, read from the changelog rather than from
 * git: the changelog is what this command already trusts, which keeps the
 * compare link consistent with the entries printed above it.
 *
 * @param {string} text
 * @param {string} tag
 * @returns {string | null}
 */
export function previousVersion(text, tag) {
	const versions = releasedVersions(text);
	const index = versions.indexOf(tag);
	if (index >= 0) return versions[index + 1] ?? null;

	// A tag not in the file yet (a dry run): the newest version below it.
	const key = versionKey(tag);
	if (key === null) return null;
	for (const candidate of versions) {
		const candidateKey = versionKey(candidate);
		if (candidateKey !== null && compareVersions(candidateKey, key) < 0) return candidate;
	}
	return null;
}

/**
 * The full GitHub release body.
 *
 * @param {{ text: string, tag: string, repo: string, previous: string | null }} options
 * @returns {string}
 */
export function renderRelease({ text, tag, repo, previous }) {
	const entries = sectionFor(text, tag);
	const version = tag.replace(/^v/, '');
	const compare = previous
		? `https://github.com/${repo}/compare/${previous}...${tag}`
		: `https://github.com/${repo}/commits/${tag}`;

	return [
		'## Container images',
		'',
		'```',
		`docker pull ghcr.io/${repo}:${version}`,
		`docker pull ghcr.io/${repo}:latest`,
		'```',
		'',
		'Multi-arch: `linux/amd64`, `linux/arm64`.',
		'',
		"## What's changed",
		'',
		entries,
		'',
		`**Full Changelog**: ${compare}`,
		'',
	].join('\n');
}

/**
 * @param {string} tag
 * @returns {boolean}
 */
function gitTagExists(tag) {
	try {
		execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function main(argv) {
	const command = argv[0];
	const rest = argv.slice(1);
	const file = new URL('../CHANGELOG.md', import.meta.url);

	/** @type {string} */
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		console.error('CHANGELOG.md not found.');
		return 1;
	}

	if (command === 'validate') {
		const problems = validate(text);
		if (problems.length > 0) {
			for (const problem of problems) console.error(`CHANGELOG.md: ${problem}`);
			return 1;
		}
		console.log('CHANGELOG.md is well-formed.');
		return 0;
	}

	if (command === 'release') {
		const tag = rest[0];
		if (!tag) {
			console.error('usage: changelog.mjs release <tag> [--repo owner/name] [--previous tag]');
			return 1;
		}
		/** @param {string} name */
		const flag = (name) => {
			const index = rest.indexOf(`--${name}`);
			return index >= 0 ? rest[index + 1] : undefined;
		};
		const repo = flag('repo') ?? process.env.GITHUB_REPOSITORY ?? 'xiphux/glyphstream';
		let previous = flag('previous') ?? previousVersion(text, tag);
		// A version in the changelog that was never tagged has no compare
		// endpoint; fall back to the commit list rather than link a 404.
		if (previous && !gitTagExists(previous)) previous = null;
		try {
			process.stdout.write(renderRelease({ text, tag, repo, previous }));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		}
		return 0;
	}

	console.error('usage: changelog.mjs <validate|release> [...]');
	return 1;
}

// Not `import.meta.main`, which needs Node 24.2. The two jobs that run this
// script deliberately skip `actions/setup-node` -- they need no pnpm install --
// so they get whatever Node the runner image ships, while every other job here
// pins 26. On an older runtime `import.meta.main` is `undefined`, so this block
// would be skipped, the process would exit 0 having printed nothing, and
// `validate` would pass on any changelog while `release` wrote an empty
// notes.md for the release action to publish. Silently, which is the failure
// this whole file exists to prevent. This form has no version floor.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(main(process.argv.slice(2)));
}
