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

import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// `vX.Y.Z` exactly. Prereleases are NOT supported, deliberately: this project
// has never shipped one and does not intend to -- anything unreleased is run
// from git or from a `sha-` image tag. Accepting the suffix here meant ordering
// it, and semver prerelease precedence is a surprising amount of machinery
// (numeric identifiers rank below alphanumeric, numerics compare numerically,
// a longer identifier list wins a tie) for a shape nothing produces. A
// `v1.0.0-rc.1` heading is now reported as not a version, which is the honest
// answer rather than a half-implemented one.
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
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
	// The open fence's marker, or null outside one. Headings are not recognised
	// inside a code block: an entry showing a markdown or YAML sample can
	// legitimately contain a line starting `## `, and treating it as a section
	// boundary either invents a bogus version or -- worse, when the fenced line
	// happens to look like one -- silently truncates the real section's body at
	// that point and publishes half the notes.
	/** @type {string | null} */
	let fence = null;

	for (const line of text.split('\n')) {
		// CommonMark allows up to three spaces of indent, and a closing fence
		// must use the same character and be at least as long as the opener.
		const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fenceMarker) {
			if (fence === null) {
				fence = fenceMarker;
			} else if (fenceMarker[0] === fence[0] && fenceMarker.length >= fence.length) {
				fence = null;
			}
			if (sections.length > 0) sections[sections.length - 1].lines.push(line);
			continue;
		}

		// `^##\s` cannot match `### `: the third `#` is not whitespace.
		const heading = fence === null ? /^##\s+(\S.*?)\s*$/.exec(line) : null;
		if (heading) {
			sections.push({ heading: heading[1], lines: [] });
		} else if (sections.length > 0) {
			sections[sections.length - 1].lines.push(line);
		}
	}
	return sections.map(({ heading, lines }) => ({ heading, body: lines.join('\n').trim() }));
}

/**
 * Sortable key for a `vX.Y.Z` heading, or null if the heading is not a version.
 *
 * @param {string} heading
 * @returns {[number, number, number] | null}
 */
function versionKey(heading) {
	const match = VERSION.exec(heading);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative when `a` is the older version
 */
function compareVersions(a, b) {
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

/**
 * Problems that make parseChangelog SILENTLY LOSE sections, which the
 * section-based checks below cannot see -- they only ever examine the sections
 * that survived.
 *
 * Both shapes here read as a single enormous section: a code fence that is
 * opened and never closed swallows every heading beneath it, and a heading
 * typed `##v0.39.0` never matches at all and joins the section above. In both
 * cases validate would report a well-formed file, sectionFor would return the
 * whole back-catalogue as the release body, `test -s` would pass because that
 * body is large rather than empty, and the compare link would quietly degrade
 * to the full commit list. Nothing would fail.
 *
 * @param {string} text
 * @returns {string[]}
 */
function lostHeadingProblems(text) {
	/** @type {string[]} */
	const problems = [];
	/** @type {string | null} */
	let fence = null;
	let openedAt = 0;

	text.split('\n').forEach((line, index) => {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (fence === null) {
				fence = marker;
				openedAt = index + 1;
			} else if (marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
			return;
		}
		if (fence === null && /^##[^\s#]/.test(line)) {
			problems.push(
				`line ${index + 1}: "${line.trim()}" needs a space after "##" to be read as a heading`,
			);
		}
	});

	if (fence !== null) {
		problems.push(
			`the code fence opened on line ${openedAt} is never closed, so every heading below it was read as body text`,
		);
	}
	return problems;
}

/**
 * Structural problems with the changelog. An empty list means valid.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function validate(text) {
	// First, because these make the section list itself untrustworthy.
	const problems = lostHeadingProblems(text);
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
	/** @type {[number, number, number] | null} */
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
			// The repository this script belongs to, not the caller's cwd. The
			// changelog is already resolved against the script so the command
			// works from anywhere; without this, git would answer for whatever
			// repository the caller happened to be standing in -- quietly
			// dropping the compare link, or worse, confirming a tag that exists
			// somewhere else.
			cwd: new URL('..', import.meta.url),
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
		const usage = 'usage: changelog.mjs release <tag> [--repo owner/name] [--previous tag]';
		const tag = rest[0];
		// A tag is positional and comes first. Without this check
		// `release --repo x/y v1.0.0` took `--repo` as the tag and failed with
		// `no "## --repo" section`, which describes the wrong problem.
		if (!tag || tag.startsWith('--')) {
			console.error(usage);
			return 1;
		}

		/**
		 * A flag's value, or undefined when the flag is absent. Throws when it
		 * is present without one: silently ignoring `--previous` with no value,
		 * or reading the next flag as its value, degrades the compare link
		 * without saying so.
		 *
		 * @param {string} name
		 * @returns {string | undefined}
		 */
		const flag = (name) => {
			const index = rest.indexOf(`--${name}`);
			if (index < 0) return undefined;
			const value = rest[index + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new Error(`--${name} needs a value.\n${usage}`);
			}
			return value;
		};

		try {
			const repo = flag('repo') ?? process.env.GITHUB_REPOSITORY ?? 'xiphux/glyphstream';
			let previous = flag('previous') ?? previousVersion(text, tag);
			// A version in the changelog that was never tagged has no compare
			// endpoint; fall back to the commit list rather than link a 404.
			if (previous && !gitTagExists(previous)) previous = null;
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
// realpathSync because Node resolves a module's OWN url through symlinks while
// process.argv[1] is only made absolute, so the two disagree whenever any
// component of the invocation path is a link -- macOS /tmp and /var both are.
// The guard would then be false, main() would never run, and the process would
// exit 0 having printed nothing: `validate` green on any changelog, `release`
// writing an empty notes.md. That is the silent no-op this guard replaced
// `import.meta.main` to avoid, so getting it wrong here costs the whole point.
//
// process.exitCode rather than process.exit(): stdout is asynchronous when it
// is a pipe, and process.exit() does not flush it, so `... | less` could
// truncate the body. Setting the code and returning lets Node flush and exit
// on its own. The workflow redirects to a file, where writes are synchronous,
// but the failure mode is again silent truncation.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
