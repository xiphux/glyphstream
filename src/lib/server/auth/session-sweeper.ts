/**
 * Periodically deletes expired sessions (see deleteExpiredSessions). Mounted
 * through createSweeper like the other background workers.
 */
import { createSweeper } from '../util/sweeper';
import { deleteExpiredSessions } from './session';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;

let running = false;

/** One pass. Safe to call directly even with the timer running. */
export async function runSessionSweep(): Promise<{ deleted: number }> {
	if (running) return { deleted: 0 };
	running = true;
	try {
		return { deleted: deleteExpiredSessions() };
	} finally {
		running = false;
	}
}

const sweeper = createSweeper({
	name: 'sessions',
	intervalMs: SWEEP_INTERVAL_MS,
	initialDelayMs: INITIAL_DELAY_MS,
	sweep: runSessionSweep,
});

export function startSessionSweeper(): void {
	sweeper.start();
}

export function stopSessionSweeper(): void {
	sweeper.stop();
}
