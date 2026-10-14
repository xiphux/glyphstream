/**
 * Running ffmpeg with a deadline that holds even when the child doesn't die.
 * Shared by the video thumbnail and the HEIC upload conversion, which both
 * decode untrusted uploads inside a slot that must come back (the thumbnail in
 * one of the three generation slots, HEIC in its own).
 */
import process from 'node:process';
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Our own deadline expiring, as opposed to ffmpeg failing.
 *
 * `execFile`'s `timeout` bounds when the KILL SIGNAL IS SENT, not when the
 * promise settles — its callback runs off the child's `close` event, and the
 * only path from the timeout to that callback is `child.kill()` itself
 * throwing. A process blocked in uninterruptible I/O (a hard NFS mount gone
 * away, a failing device) cannot be reaped, so the promise never settles, the
 * `finally` that releases the generation slot never runs, and the `inFlight`
 * entry keeps handing that dead promise to every later caller — who then await
 * it forever, with no response.
 *
 * Racing an independent timer means the slot comes back whether or not the
 * child ever does. It does NOT reap the child; nothing in Node can. That is the
 * OS's problem, and one leaked process is a great deal better than one leaked
 * slot out of three shared with every image thumbnail.
 */
export class FfmpegDeadline extends Error {
	constructor(seconds: number) {
		super(`ffmpeg did not settle within ${seconds}s`);
		this.name = 'FfmpegDeadline';
	}
}

/** How long past the caller's budget to wait before giving up on the child
 *  settling at all. Non-zero so the ordinary case — SIGKILL lands, execFile
 *  rejects — still surfaces ffmpeg's own error rather than ours. */
const FFMPEG_REAP_GRACE_MS = 2_000;

/**
 * Run ffmpeg with `args`, writing `outputAbs`. Rejects with ffmpeg's own error,
 * or with `FfmpegDeadline` when the child hasn't settled `FFMPEG_REAP_GRACE_MS`
 * after `budgetMs` (in which case `outputAbs` is removed whenever it does).
 */
export async function runFfmpeg(
	args: string[],
	budgetMs: number,
	outputAbs: string,
): Promise<void> {
	const run = execFileAsync('ffmpeg', args, {
		timeout: budgetMs,
		killSignal: 'SIGKILL',
		maxBuffer: 1024 * 1024,
		// An explicit environment rather than inheriting this process's. Node
		// passes the parent's env by default, and ours holds AUTH_SECRET,
		// MCP_SECRET_KEY and every per-endpoint API token — none of which a
		// media decoder has any use for. PATH is kept because that is how the
		// binary is found at all.
		env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
	});

	// Attached before the race so a rejection arriving after we've given up is
	// already handled and can't surface as an unhandled rejection.
	run.catch(() => {});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new FfmpegDeadline((budgetMs + FFMPEG_REAP_GRACE_MS) / 1000)),
			budgetMs + FFMPEG_REAP_GRACE_MS,
		);
		// Don't hold the event loop open. The awaited promise is what keeps the
		// work alive; without this, a shutdown during an in-flight decode waits
		// out the full remaining timer.
		timer.unref?.();
	});

	try {
		await Promise.race([run, deadline]);
	} catch (e) {
		if (e instanceof FfmpegDeadline) {
			// We have given up on this child, but it may still be alive and may yet
			// create its output — after the caller's own cleanup has run. Nothing
			// will ever reference this path again, and nothing sweeps DERIVED_DIR,
			// so reclaim it whenever the child finally settles. Not awaited: the
			// point of the deadline is that this may be never.
			void run.finally(() => unlink(outputAbs).catch(() => {})).catch(() => {});
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}
