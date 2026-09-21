/**
 * CHANGELOG.md is the only source of release notes, so the parser that reads it
 * gates every release. A malformed file that still parses would publish the
 * empty notes the changelog was introduced to stop, which is why `validate`
 * carries as many cases here as the extractor does.
 *
 * The committed CHANGELOG.md is checked too: a broken one fails the same way in
 * CI, but failing here as well names the problem while you are still editing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	parseChangelog,
	previousVersion,
	releasedVersions,
	renderRelease,
	sectionFor,
	validate,
} from '../../scripts/changelog.mjs';

const VALID = [
	'# Changelog',
	'',
	'Prose above the first heading is not part of any section.',
	'',
	'## Unreleased',
	'',
	'### Added',
	'',
	'- something pending',
	'',
	'## v0.2.0',
	'',
	'### Fixed',
	'',
	'- a released fix',
	'',
	'## v0.1.0',
	'',
	'- the first release',
	'',
].join('\n');

describe('parseChangelog', () => {
	it('splits on "## " and keeps file order', () => {
		expect(parseChangelog(VALID).map((s) => s.heading)).toEqual(['Unreleased', 'v0.2.0', 'v0.1.0']);
	});

	it('does not treat "### " subheadings as sections', () => {
		const headings = parseChangelog(VALID).map((s) => s.heading);
		expect(headings).not.toContain('Added');
		expect(headings).not.toContain('Fixed');
	});

	it('keeps subheadings inside the section body', () => {
		const unreleased = parseChangelog(VALID)[0];
		expect(unreleased.body).toContain('### Added');
		expect(unreleased.body).toContain('- something pending');
	});

	it('drops the preamble above the first heading', () => {
		expect(parseChangelog(VALID).some((s) => s.body.includes('Prose above'))).toBe(false);
	});

	it('does not read a "## " line inside a fenced code block as a heading', () => {
		// The dangerous shape: a fenced line that looks like a version. Before
		// fence tracking this passed validation AND truncated v1.0.0's body at
		// the fence, so the published notes silently lost everything below it.
		const text = [
			'# Changelog',
			'',
			'## v1.0.0',
			'',
			'- shows a sample:',
			'',
			'```markdown',
			'## v0.95.0',
			'```',
			'',
			'- and a trailing entry',
			'',
			'## v0.9.0',
			'',
			'- old',
			'',
		].join('\n');

		expect(parseChangelog(text).map((s) => s.heading)).toEqual(['v1.0.0', 'v0.9.0']);
		expect(validate(text)).toEqual([]);
		expect(sectionFor(text, 'v1.0.0')).toContain('and a trailing entry');
	});

	it('closes a fence only on a marker at least as long, of the same character', () => {
		const text = [
			'# Changelog',
			'',
			'## v1.0.0',
			'',
			'````',
			'```',
			'## v0.5.0',
			'````',
			'',
			'- after',
			'',
		].join('\n');
		expect(parseChangelog(text).map((s) => s.heading)).toEqual(['v1.0.0']);
		expect(sectionFor(text, 'v1.0.0')).toContain('- after');
	});

	it('tracks a tilde fence as well as a backtick one', () => {
		const text = '# Changelog\n\n## v1.0.0\n\n~~~\n## v0.5.0\n~~~\n\n- after\n';
		expect(parseChangelog(text).map((s) => s.heading)).toEqual(['v1.0.0']);
	});
});

describe('validate', () => {
	it('accepts a well-formed file', () => {
		expect(validate(VALID)).toEqual([]);
	});

	it('rejects a released version with no entries', () => {
		const text = '# Changelog\n\n## v0.2.0\n\n## v0.1.0\n\n- entry\n';
		expect(validate(text)).toContain('"## v0.2.0" has no entries');
	});

	it('allows an empty Unreleased section, which just means nothing is pending', () => {
		const text = '# Changelog\n\n## Unreleased\n\n## v0.1.0\n\n- entry\n';
		expect(validate(text)).toEqual([]);
	});

	it('rejects versions that are not newest-first', () => {
		const text = '# Changelog\n\n## v0.1.0\n\n- a\n\n## v0.2.0\n\n- b\n';
		expect(validate(text)).toContain(
			'"## v0.2.0" is not below the version above it (newest first)',
		);
	});

	it('rejects a duplicated version', () => {
		const text = '# Changelog\n\n## v0.2.0\n\n- a\n\n## v0.2.0\n\n- b\n';
		expect(validate(text)).toContain('"## v0.2.0" appears more than once');
	});

	it('rejects a heading that is neither Unreleased nor a version', () => {
		const text = '# Changelog\n\n## Release three\n\n- a\n';
		expect(validate(text)).toContain(
			'"## Release three" is neither "Unreleased" nor a vX.Y.Z version',
		);
	});

	it('rejects Unreleased below a released version', () => {
		const text = '# Changelog\n\n## v0.1.0\n\n- a\n\n## Unreleased\n\n- b\n';
		expect(validate(text)).toContain('"Unreleased" must be the first section');
	});

	it('rejects a file that does not start with "# Changelog"', () => {
		const text = '# Release notes\n\n## v0.1.0\n\n- a\n';
		expect(validate(text)).toContain('the first line must be "# Changelog"');
	});

	it('rejects a file with no sections at all', () => {
		expect(validate('# Changelog\n\nnothing here\n')).toContain('no "## " release sections found');
	});

	it('accepts a prerelease version', () => {
		expect(validate('# Changelog\n\n## v1.0.0-rc.1\n\n- a\n')).toEqual([]);
	});

	it('accepts a release above its own prereleases', () => {
		// The suffix used to be parsed and then thrown away, so these compared
		// equal and a correctly ordered file was reported as out of order.
		const text =
			'# Changelog\n\n## v1.0.0\n\n- final\n\n## v1.0.0-rc.2\n\n- rc2\n\n## v1.0.0-rc.1\n\n- rc1\n';
		expect(validate(text)).toEqual([]);
	});

	it('rejects a prerelease listed above its own release', () => {
		const text = '# Changelog\n\n## v1.0.0-rc.1\n\n- rc\n\n## v1.0.0\n\n- final\n';
		expect(validate(text)).toContain(
			'"## v1.0.0" is not below the version above it (newest first)',
		);
	});

	it('orders prerelease identifiers by semver precedence, not as strings', () => {
		// rc.10 outranks rc.9 numerically; a string sort would disagree.
		const text = '# Changelog\n\n## v1.0.0-rc.10\n\n- ten\n\n## v1.0.0-rc.9\n\n- nine\n';
		expect(validate(text)).toEqual([]);
	});
});

describe('sectionFor', () => {
	it('returns just that version, without its heading', () => {
		const body = sectionFor(VALID, 'v0.2.0');
		expect(body).toContain('- a released fix');
		expect(body).not.toContain('v0.1.0');
		expect(body).not.toContain('## v0.2.0');
	});

	it('throws for a version with no section, naming the fix', () => {
		expect(() => sectionFor(VALID, 'v0.3.0')).toThrow(/no "## v0\.3\.0" section/);
		expect(() => sectionFor(VALID, 'v0.3.0')).toThrow(/Rename "## Unreleased"/);
	});

	it('throws for an empty section rather than returning nothing', () => {
		const text = '# Changelog\n\n## v0.2.0\n\n## v0.1.0\n\n- entry\n';
		expect(() => sectionFor(text, 'v0.2.0')).toThrow(/is empty/);
	});
});

describe('previousVersion', () => {
	it('is the next version down', () => {
		expect(previousVersion(VALID, 'v0.2.0')).toBe('v0.1.0');
	});

	it('is null for the oldest release', () => {
		expect(previousVersion(VALID, 'v0.1.0')).toBeNull();
	});

	it('skips Unreleased', () => {
		expect(releasedVersions(VALID)).toEqual(['v0.2.0', 'v0.1.0']);
	});

	it('finds the newest version below a tag not yet in the file', () => {
		expect(previousVersion(VALID, 'v0.3.0')).toBe('v0.2.0');
	});

	it('treats a release as newer than its own prerelease', () => {
		const text =
			'# Changelog\n\n## v1.0.0\n\n- final\n\n## v1.0.0-rc.1\n\n- rc\n\n## v0.9.0\n\n- old\n';
		expect(previousVersion(text, 'v1.0.0')).toBe('v1.0.0-rc.1');
		expect(previousVersion(text, 'v1.0.0-rc.1')).toBe('v0.9.0');
	});
});

describe('renderRelease', () => {
	const body = renderRelease({
		text: VALID,
		tag: 'v0.2.0',
		repo: 'xiphux/glyphstream',
		previous: 'v0.1.0',
	});

	it('carries the pull commands for that exact version', () => {
		expect(body).toContain('docker pull ghcr.io/xiphux/glyphstream:0.2.0');
		expect(body).toContain('docker pull ghcr.io/xiphux/glyphstream:latest');
	});

	it('carries the changelog entries', () => {
		expect(body).toContain('- a released fix');
	});

	it('links a compare view when there is a previous release', () => {
		expect(body).toContain('/compare/v0.1.0...v0.2.0');
	});

	it('links the commit list for a first release', () => {
		const first = renderRelease({
			text: VALID,
			tag: 'v0.1.0',
			repo: 'xiphux/glyphstream',
			previous: null,
		});
		expect(first).toContain('/commits/v0.1.0');
		expect(first).not.toContain('/compare/');
	});
});

describe('the committed CHANGELOG.md', () => {
	const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

	it('is well-formed', () => {
		expect(validate(text)).toEqual([]);
	});

	it('has an entry for the current package version', () => {
		const pkg = JSON.parse(
			readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
		) as { version: string };
		// Exactly the check docker.yml's release job runs, rather than a weaker
		// restatement of it: sectionFor also rejects a section that exists but
		// is empty, and its message is the instruction to follow.
		//
		// This holds continuously because the version here moves only at
		// release -- the `Version X.Y.Z` commit IS the tagged commit -- so
		// between releases package.json names the last RELEASED version, whose
		// section exists. A fat `## Unreleased` above it is irrelevant, since
		// this asks whether the section exists at all, not where it sits. The
		// window where it fails is the one commit that bumps the version
		// without renaming Unreleased, which is the mistake worth catching.
		expect(() => sectionFor(text, `v${pkg.version}`)).not.toThrow();
	});
});
