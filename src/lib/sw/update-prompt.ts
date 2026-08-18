/**
 * Whether a waiting service worker is worth interrupting the user for.
 *
 * The page and the worker update on independent schedules, and only the page
 * is fast. There is no navigation fallback, so a cold launch fetches the
 * current HTML + JS straight from the server — the user is on the new build
 * before the worker has even looked. The worker then updates through its own
 * lifecycle, lands in `waiting`, and the PWA plugin raises onNeedRefresh for a
 * version the page has been running since first paint.
 *
 * Left to the lifecycle alone, that fires on the FIRST launch after every
 * deploy, offering a refresh onto the build already on screen. Which is the
 * quickest way to train someone to ignore the one prompt that has to be
 * believed — and this app only just got that prompt working again after it
 * spent a release silently broken.
 *
 * So the rule compares builds instead of trusting the lifecycle. Kept here as
 * a pure function, in the shape `arbiter.ts` established: the decision is
 * unit-tested, and the layout keeps only the messaging around it.
 */
export function shouldPromptForUpdate(pageBuild: string, waitingBuild: string | null): boolean {
	// No answer — a worker built before GET_BUILD existed, or one that failed
	// to boot. Fail open: an unnecessary prompt is a papercut, a swallowed one
	// leaves the user on stale code with no way to find out.
	if (waitingBuild === null) return true;
	// Same build: the worker is merely catching up with the page. It activates
	// on its own once every client closes, so there is nothing to offer and
	// nothing for the user to do.
	return waitingBuild !== pageBuild;
}
