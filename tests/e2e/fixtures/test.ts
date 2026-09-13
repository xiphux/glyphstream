/**
 * The e2e `test`: Playwright's, plus an automatic check that the test produced
 * no unexpected server-side errors and no uncaught browser exceptions.
 *
 * Specs import `test` / `expect` from here rather than '@playwright/test'.
 *
 * - Server: the app server runs with `capture-server-errors.mjs` preloaded,
 *   which appends every `console.error` and uncaught exception to a JSONL file.
 *   Each test reads only the lines written while it ran.
 * - Browser: `weberror` catches uncaught exceptions and unhandled rejections
 *   from any page the test opened — in the default context and in any context
 *   the test creates with `browser.newContext()` (a second user, signed out).
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
import { test as base, expect, type Browser, type BrowserContext } from '@playwright/test';
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
		async ({ browser, context, allowedServerErrors }, use, testInfo) => {
			const offset = logSize();
			const pageErrors: string[] = [];
			const watch = (ctx: BrowserContext) =>
				ctx.on('weberror', (webError) => {
					const err = webError.error();
					pageErrors.push(err.stack ?? err.message);
				});
			watch(context);

			// Specs open extra contexts for a second user or a signed-out visitor;
			// their pages need the same watch. `browser` is worker-scoped, and
			// workers=1 runs tests one at a time, so wrapping it for the duration of
			// this test (restored below) can't leak into another test.
			const originalNewContext = browser.newContext.bind(browser);
			browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
				const ctx = await originalNewContext(...args);
				watch(ctx);
				return ctx;
			};

			try {
				await use();
			} finally {
				browser.newContext = originalNewContext;
			}

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
