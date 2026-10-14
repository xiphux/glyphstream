/**
 * Server logging: a `[scope]` prefix and a LOG_LEVEL threshold.
 *
 * Output is exactly what the hand-written `console.warn('[scope] …')` calls it
 * replaced produced: one string with the prefix, then any further arguments
 * passed through untouched (an Error still prints with its stack). Each level
 * goes to the `console` method of the same name, so stdout/stderr routing is
 * unchanged and a test can still spy on `console.warn`.
 *
 * LOG_LEVEL is `debug`, `info` (the default), `warn` or `error`; anything else
 * reads as `info`. It is read on every call rather than once, so a test or an
 * operator's change takes effect without a module reload. That costs one
 * `process.env` lookup per line actually logged, which is nothing.
 *
 * Read from `process.env` here rather than through `env.ts`: thirty-odd unit
 * tests mock `#lib/server/env.js` with only the getters they need, and every
 * module that logged through a mocked `logLevel` crashed unless the mock
 * remembered to stub it too.
 */
import process from 'node:process';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function threshold(): number {
	const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
	return configured && configured in LEVELS ? LEVELS[configured as LogLevel] : LEVELS.info;
}

export interface Logger {
	debug(message: string, ...rest: unknown[]): void;
	info(message: string, ...rest: unknown[]): void;
	warn(message: string, ...rest: unknown[]): void;
	error(message: string, ...rest: unknown[]): void;
	/** Whether `level` would print: for skipping work that only feeds a log line. */
	enabled(level: LogLevel): boolean;
}

/** A logger whose lines start `[scope]`. Cheap; create one per module, or per
 *  call where the scope is dynamic. */
export function createLogger(scope: string): Logger {
	const enabled = (level: LogLevel) => LEVELS[level] >= threshold();
	const at =
		(level: LogLevel) =>
		(message: string, ...rest: unknown[]) => {
			if (!enabled(level)) return;
			console[level](message ? `[${scope}] ${message}` : `[${scope}]`, ...rest);
		};
	return {
		debug: at('debug'),
		info: at('info'),
		warn: at('warn'),
		error: at('error'),
		enabled,
	};
}
