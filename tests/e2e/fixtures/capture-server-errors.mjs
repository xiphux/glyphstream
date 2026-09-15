/**
 * Preloaded into the e2e app server (`node --import …`) so a server-side error
 * fails the spec that caused it instead of scrolling past in the webServer log.
 *
 * Two green-looking regressions shipped through e2e that way: every generated
 * thumbnail failing in sharp, and the stream recorder hitting a FOREIGN KEY
 * error. Both were logged, and nothing read the log.
 *
 * Appends one JSON line per `console.error` call and per uncaught exception to
 * E2E_SERVER_ERRORS_LOG; `tests/e2e/fixtures/test.ts` reads the lines each test
 * produced. Deliberately narrow: `console.warn` is for expected degradation and
 * stays out, and `uncaughtExceptionMonitor` observes without changing Node's
 * crash-on-uncaught behaviour (a plain `uncaughtException` listener would
 * swallow it).
 *
 * Node's own process warnings stay out too. Its default warning handler prints
 * through `console.error`, so an `ExperimentalWarning` (@simplewebauthn/server
 * 14 probes Web Crypto's experimental ML-DSA-44 support on the first passkey
 * registration) read as a server error and failed whichever spec registered
 * first. A warning isn't a failure; it still lands in the server log.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { format } from 'node:util';

const logPath = process.env.E2E_SERVER_ERRORS_LOG;

if (logPath) {
	mkdirSync(dirname(logPath), { recursive: true });

	const record = (kind, text) => {
		try {
			appendFileSync(logPath, JSON.stringify({ t: Date.now(), kind, text }) + '\n');
		} catch {
			// Never let the capture itself break the server under test.
		}
	};

	// "(node:1234) ExperimentalWarning: …", "(node:1234) [DEP0040] DeprecationWarning: …"
	const nodeWarning = /^\(node:\d+\) (\[[A-Z0-9]+\] )?\w*Warning: /;

	const originalError = console.error.bind(console);
	console.error = (...args) => {
		const text = format(...args);
		if (!nodeWarning.test(text)) record('console.error', text);
		originalError(...args);
	};

	process.on('uncaughtExceptionMonitor', (err, origin) => {
		record(origin, err instanceof Error ? (err.stack ?? err.message) : String(err));
	});
}
