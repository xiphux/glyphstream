import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

/**
 * The dependency audit fails a change only for advisories it adds over a
 * baseline, so the baseline is half the gate. scripts/audit-baseline.sh picks
 * it -- the last commit CI passed on the target branch -- and needs three
 * things from the workflow to do so: the full history, to reach that commit;
 * `actions: read`, to look up which runs passed; and the workflows whose runs
 * include the audit. The audit then has to be handed what it found. Each of
 * those was once missing or wrong in some repository here, and none of them
 * fails anything visibly when it is: a shallow clone fails the step, but a
 * dropped AUDIT_BASE quietly falls back to comparing against HEAD's parent,
 * which is what let multi-commit pushes through. So they are pinned here.
 */

const WORKFLOWS = path.join(process.cwd(), '.github', 'workflows');
const CI = 'ci.yml';
const JOB = 'static';
const AUDIT_STEPS = ['Dependency audit'];
const CALLER = { workflow: 'docker.yml', job: 'tests' };

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
};
type Job = { permissions?: Record<string, string>; steps?: Step[] };
const load = (file: string) =>
	parse(readFileSync(path.join(WORKFLOWS, file), 'utf8')) as {
		jobs: Record<string, Job>;
	};

describe('the dependency audit compares against a verified baseline', () => {
	const job = load(CI).jobs[JOB];
	const steps = job?.steps ?? [];
	const baseline = steps.find((step) => step.id === 'audit-baseline');
	const audits = AUDIT_STEPS.map((name) => steps.find((step) => step.name === name));

	it('has the job and steps this describes', () => {
		expect(job).toBeDefined();
		expect(baseline).toBeDefined();
		expect(audits).not.toContain(undefined);
	});

	it('checks out the full history', () => {
		const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
		expect(checkout?.with?.['fetch-depth']).toBe(0);
	});

	it('may look up earlier runs', () => {
		expect(job?.permissions?.actions).toBe('read');
	});

	it('finds the baseline before any audit runs', () => {
		expect(baseline?.run).toBe('scripts/audit-baseline.sh');
		for (const audit of audits) {
			expect(steps.indexOf(baseline!)).toBeLessThan(steps.indexOf(audit!));
		}
	});

	it('looks the baseline up in workflows that exist', () => {
		const workflows = baseline?.env?.AUDIT_WORKFLOWS?.split(',') ?? [];
		expect(workflows.length).toBeGreaterThan(0);
		for (const workflow of workflows) {
			expect(existsSync(path.join(WORKFLOWS, workflow))).toBe(true);
		}
		expect(baseline?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(baseline?.env?.AUDIT_DEFAULT_BRANCH).toBe(
			'${{ github.event.repository.default_branch }}',
		);
	});

	it('hands every audit the baseline it found', () => {
		for (const audit of audits) {
			expect(audit?.env?.AUDIT_BASE).toBe('${{ steps.audit-baseline.outputs.sha }}');
			expect(audit?.run).toMatch(/scripts\/audit-new-advisories\.mjs/);
		}
	});

	it('is granted that lookup by the workflow that calls it', () => {
		if (!CALLER.workflow) return;
		const caller = load(CALLER.workflow).jobs[CALLER.job];
		expect(caller?.permissions?.actions).toBe('read');
	});
});
