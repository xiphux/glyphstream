import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

/**
 * The dependency audit fails a change only for advisories it adds over a
 * baseline, so the baseline is half the gate. scripts/audit-baseline.sh picks
 * it -- the last commit CI passed on the target branch -- and needs three
 * things from the workflow to do so: the full history, to reach that commit;
 * `actions: read`, to look up which runs passed; and the workflows whose runs
 * include the audit. The audit then has to be handed what it found. Not all
 * of those fail visibly when wrong: a workflow in AUDIT_WORKFLOWS that goes
 * green without auditing makes every commit it passes a baseline, and a
 * renamed step id hands the audit an empty baseline. So they are pinned here.
 *
 * So is the audit job's independence from `gate`. The other checks may skip
 * when the content already passed; the audit may not, since advisories are
 * published while content stands still, and a merge that inherited a pull
 * request's pass would become a baseline nothing audited.
 *
 * And so is the job's name. Branch protection requires the audit by the
 * check name GitHub reports -- the job's `name:`, or its id without one --
 * and a required check that is never reported is simply never waited for:
 * after a rename, auto-merge would stop waiting on the audit and nothing
 * would go red to say so. Renaming it means updating the required checks
 * too.
 */

const WORKFLOWS = path.join(process.cwd(), '.github', 'workflows');
const CI = 'ci.yml';
const JOB = 'audit';
/** The check name branch protection requires; undefined for the job id. */
const JOB_NAME: string | undefined = 'Dependency audit';
/** Each audit step, by name, and exactly what it runs. */
const AUDIT_STEPS: Array<{ name: string; run: string }> = [
	{ name: 'Dependency audit', run: 'node scripts/audit-new-advisories.mjs' },
];

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
	'continue-on-error'?: boolean | string;
};
type Job = {
	name?: string;
	if?: string;
	needs?: string | string[];
	uses?: string;
	permissions?: Record<string, string>;
	steps?: Step[];
	'continue-on-error'?: boolean | string;
};
const load = (file: string) =>
	parse(readFileSync(path.join(WORKFLOWS, file), 'utf8')) as {
		jobs: Record<string, Job>;
	};

/** Every workflow with a job that calls the CI workflow, with those jobs. */
const callers = readdirSync(WORKFLOWS)
	.filter((file) => /\.ya?ml$/.test(file))
	.map((file) => ({
		file,
		jobs: Object.values(load(file).jobs ?? {}).filter(
			(job) => job.uses === `./.github/workflows/${CI}`,
		),
	}))
	.filter(({ jobs }) => jobs.length > 0);

describe('the dependency audit compares against a verified baseline', () => {
	const job = load(CI).jobs[JOB];
	const steps = job?.steps ?? [];
	const baseline = steps.find((step) => step.id === 'audit-baseline');
	const audits = AUDIT_STEPS.map(({ name }) => steps.find((step) => step.name === name));

	it('has the job and steps this describes', () => {
		expect(job).toBeDefined();
		expect(baseline).toBeDefined();
		expect(audits).not.toContain(undefined);
	});

	it('reports under the name branch protection requires', () => {
		expect(job?.name).toBe(JOB_NAME);
	});

	it('never skips the audit, and never lets it fail quietly', () => {
		// No `needs: gate`, no condition: it runs on every run of the workflow.
		expect(job?.if).toBeUndefined();
		expect(job?.needs).toBeUndefined();
		expect(job?.['continue-on-error']).toBeUndefined();
		for (const step of [baseline, ...audits]) {
			expect(step?.if, step?.name).toBeUndefined();
			expect(step?.['continue-on-error'], step?.name).toBeUndefined();
		}
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

	it('looks the baseline up only in workflows that run the audit', () => {
		const workflows = baseline?.env?.AUDIT_WORKFLOWS?.split(',') ?? [];
		expect(workflows.length).toBeGreaterThan(0);
		const auditing = [CI, ...callers.map(({ file }) => file)];
		for (const workflow of workflows) {
			expect(auditing, workflow).toContain(workflow);
		}
		expect(baseline?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(baseline?.env?.AUDIT_DEFAULT_BRANCH).toBe(
			'${{ github.event.repository.default_branch }}',
		);
	});

	it('hands every audit the baseline it found, and runs it as written', () => {
		AUDIT_STEPS.forEach(({ run }, i) => {
			expect(audits[i]?.env?.AUDIT_BASE).toBe('${{ steps.audit-baseline.outputs.sha }}');
			expect(audits[i]?.run?.trim()).toBe(run);
		});
	});

	it('is granted that lookup by every workflow that calls it', () => {
		for (const { file, jobs } of callers) {
			for (const caller of jobs) {
				expect(caller.permissions?.actions, file).toBe('read');
			}
		}
	});
});
