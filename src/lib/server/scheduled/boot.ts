/**
 * When this server process started, as far as scheduled runs are concerned: a
 * run's turn lives only in the process that started it, so a run row filed
 * before this moment that still reads queued or running is a dead process's —
 * nothing is behind it. Fixed at first evaluation (the runner, imported by
 * `hooks.server.ts`, gets here at startup) and kept on globalThis, because a
 * dev HMR re-evaluation is not a new process and must not move the line.
 */
const BOOTED = Symbol.for('glyphstream.scheduledRunnerBootedAt');
type GlobalWithBoot = typeof globalThis & { [BOOTED]?: number };

const g = globalThis as GlobalWithBoot;
g[BOOTED] ??= Date.now();

export function processBootedAt(): number {
	return g[BOOTED] ?? Date.now();
}
