/**
 * The e2e `test`: Playwright's, plus an automatic check that the test produced
 * no unexpected server-side errors and no uncaught browser exceptions.
 *
 * Specs import `test` / `expect` from here rather than '@playwright/test'.
 *
 * - Server: the app server runs with `capture-server-errors.mjs` preloaded,
 *   which appends every `console.error` and uncaught exception to a JSONL file.
 *   Each test reads only the lines written while it ran.
 * - Browser: `weberror` on the context catches uncaught exceptions and
 *   unhandled rejections from any page the test opened.
 *
 * A test that provokes a server error on purpose says so, and only for itself:
 *
 *   test.use({ allowedServerErrors: [/\[stream\/relay\] upstream failed/] });
 *
 * Attribution is by time window. workers=1 keeps it meaningful, but async
 * server work outliving its test lands in the next one's window — which is
 * itself a finding worth seeing, not noise to allowlist.
 */
import { readFileSync, statSync } from 'node:fs';
import { test as base, expect } from '@playwright/test';
import { SERVER_ERRORS_LOG } from './paths';

export * from '@playwright/test';
export { expect };

export { SERVER_ERRORS_LOG };

interface ServerErrorEntry {
	t: number;
	kind: string;
	text: string;
}

function logSize(): number {
	try {
		return statSync(SERVER_ERRORS_LOG).size;
	} catch {
		return 0;
	}
}

function entriesSince(offset: number): ServerErrorEntry[] {
	let buf: Buffer;
	try {
		buf = readFileSync(SERVER_ERRORS_LOG);
	} catch {
		return [];
	}
	return buf
		.subarray(offset)
		.toString('utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as ServerErrorEntry];
			} catch {
				return [];
			}
		});
}

export const test = base.extend<{
	allowedServerErrors: RegExp[];
	_failOnUnexpectedErrors: void;
}>({
	allowedServerErrors: [[], { option: true }],

	_failOnUnexpectedErrors: [
		async ({ context, allowedServerErrors }, use, testInfo) => {
			const offset = logSize();
			const pageErrors: string[] = [];
			context.on('weberror', (webError) => {
				const err = webError.error();
				pageErrors.push(err.stack ?? err.message);
			});

			await use();

			const unexpected = entriesSince(offset).filter(
				(e) => !allowedServerErrors.some((re) => re.test(e.text)),
			);
			const problems = [
				...unexpected.map((e) => `server ${e.kind}: ${e.text}`),
				...pageErrors.map((text) => `page error: ${text}`),
			];
			if (problems.length > 0 && testInfo.status === testInfo.expectedStatus) {
				throw new Error(
					`Test produced ${problems.length} unexpected error(s):\n\n` +
						problems.map((p) => p.slice(0, 2000)).join('\n\n'),
				);
			}
		},
		{ auto: true },
	],
});
