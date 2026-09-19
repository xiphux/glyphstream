import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * ci.yml's check jobs may skip, on master and on a release tag, when `gate`
 * finds that this content has already gone green. So `gate` is the only thing
 * standing between a commit and an image that verified nothing — docker.yml
 * runs `build` behind `needs: tests`, and nothing else re-checks.
 *
 * Two properties keep that honest, and both are asserted here rather than
 * left to the comments.
 *
 * First, nothing but `gate` decides to skip: every check job's condition
 * defers to it and says nothing of its own about refs, events or paths.
 *
 * Second, a red check must stop the build. `needs: test` does that — any
 * job in the called workflow going red fails it, including one nobody
 * remembered to wire up. But a workflow is not failed by a job that SKIPS,
 * nor by one that goes red under `continue-on-error`, so a check of either
 * shape would sail straight past that guarantee.
 */

const WORKFLOWS = join(import.meta.dirname, '..', '..', '.github', 'workflows');

interface Step {
	id?: string;
	env?: Record<string, string>;
	name?: string;
	uses?: string;
	run?: string;
	'continue-on-error'?: boolean;
}

interface Job {
	if?: string;
	needs?: string | string[];
	'continue-on-error'?: boolean;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	steps?: Step[];
}

const load = (file: string) =>
	(
		parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as {
			jobs: Record<string, Job>;
		}
	).jobs;

describe('an inherited pass cannot be faked', () => {
	const jobs = load('ci.yml');

	// The one condition a check job may carry: skip iff the gate reported a
	// pass. Deciding WHEN that is legitimate belongs to `gate` alone.
	const GATE_SKIP = "${{ !cancelled() && needs.gate.outputs.passed != 'true' }}";

	const checks = Object.keys(jobs).filter((name) => name !== 'gate');

	it('has check jobs to guard', () => {
		// Without this the suite passes vacuously if the jobs are renamed or the
		// `jobs:` key changes shape — green from a rule that matches nothing.
		expect(checks.length).toBeGreaterThan(0);
	});

	it.each(checks)('cannot let %s pass without running it', (name) => {
		expect(jobs[name]?.if).toBe(GATE_SKIP);
		expect(jobs[name]?.['continue-on-error'] ?? false).toBe(false);
	});

	it.each(checks)('does not let a step in %s fail quietly', (name) => {
		// The job-level key is the obvious way to report an unearned pass; a
		// step-level one is the easy way, and leaves the job green over a red
		// check. `gate` is the one legitimate use here and is outside `checks`.
		const offenders = (jobs[name]?.steps ?? [])
			.map((step, i) => ({
				step,
				label: step.name ?? step.uses ?? `step ${i}`,
			}))
			.filter(({ step }) => step['continue-on-error'])
			.map(({ label }) => label);
		expect(offenders).toEqual([]);
	});
});

describe('the gate claims a pass only when one was earned', () => {
	const gate = load('ci.yml').gate;
	const script = gate?.steps?.find((step) => step.id === 'inherit')?.run ?? '';

	it('runs on master and on tags, and nowhere else', () => {
		// Both refs matter and for different reasons: main is the merge case,
		// a tag is the release case. Dropping the tag clause would silently make
		// every publish pay for a full re-run of checks it already has.
		expect(gate?.if).toContain("github.ref == 'refs/heads/main'");
		expect(gate?.if).toContain("startsWith(github.ref, 'refs/tags/')");
	});

	it('keeps both lookups', () => {
		// They cover different cases and neither subsumes the other: the SHA
		// lookup is what makes a tagged release cheap, the tree lookup is what
		// makes a merge cheap. Losing one is a silent halving, since the other
		// still answers and nothing goes red.
		expect(script).toContain('GITHUB_SHA');
		expect(script).toContain('HEAD^2');
	});

	it('never treats this run as evidence about itself', () => {
		// The SHA lookup lists runs for this commit, and this run is in that
		// list. Without the exclusion it would find itself in progress — or,
		// worse, succeed on a re-run by reading its own earlier attempt.
		expect(script).toContain('GITHUB_RUN_ID');
	});

	it('re-checks for real when a run is retried', () => {
		// "Re-run all jobs" is what you reach for when you doubt a result, so
		// inheriting on a retry would hand back the same answer and leave no way
		// to force a genuine check short of pushing an empty commit.
		expect(script).toContain('GITHUB_RUN_ATTEMPT');
	});

	it('fails closed when the job itself breaks', () => {
		expect(gate?.['continue-on-error']).toBe(true);
	});

	it('derives `passed` from the inherit step and nothing else', () => {
		// Never a literal, and never a fallback whose default is "verified".
		expect(gate?.outputs?.['passed']).toBe('${{ steps.inherit.outputs.passed }}');
	});

	it('claims the inherited pass on exactly one line, the last', () => {
		// Both lookups exit BEFORE the claim on every path that does not inherit,
		// so a single occurrence at the end is the shape of "nothing objected".
		expect(script).not.toBe('');
		expect(script.match(/passed=true/g) ?? []).toHaveLength(1);
		expect(script.trimEnd().split('\n').at(-1)).toContain('passed=true');
	});

	it('is granted the scope its lookups need', () => {
		// The one failure here that is invisible rather than loud: without
		// `actions: read` both lookups fail, the gate reports "not verified", and
		// every merge and every tag quietly pays full price with nothing red.
		expect(gate?.permissions?.['actions']).toBe('read');
	});
});

describe('docker.yml cannot act on an unearned pass', () => {
	const jobs = load('docker.yml');

	it('keeps the build gated on the checks actually concluding success', () => {
		// Deliberately bare. A called workflow whose jobs ALL skip concludes
		// `skipped`, not success, so skipping the build is the correct response
		// to the checks having verified nothing -- adding `!cancelled()` or
		// `always()` here would push an image whose checks went red.
		//
		// That cannot arise while `gate` runs on main and tags: it is itself a
		// job that concluded, so the called workflow resolves to success rather
		// than skipped even when every check skips.
		expect(jobs['build']?.needs).toBe('tests');
		expect(jobs['build']?.if).toBeUndefined();
	});

	it('names a workflow for each lookup, and they differ', () => {
		// ci.yml never has a run of its own on main or a tag -- docker.yml calls
		// it, and a called workflow runs inside the caller's run. So the
		// branch/tag evidence is a docker.yml run while the pull-request
		// evidence is a ci.yml run, and collapsing the two onto one name would
		// break whichever case lost its workflow, silently and with nothing red.
		const env = load('ci.yml').gate?.steps?.find((step) => step.id === 'inherit')?.env;
		expect(env?.['SAME_SHA_WORKFLOW']).toBe('.github/workflows/docker.yml');
		expect(env?.['PR_WORKFLOW']).toBe('.github/workflows/ci.yml');
	});
});
