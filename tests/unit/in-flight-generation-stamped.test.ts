/**
 * Every route that registers an in-flight generation must end up with
 * `generationStartedAt` stamped when the concurrency gate grants a slot.
 *
 * The field is the whole definition of "queued rather than running": the
 * sidebar's mark, the layout seed and the 5s poll all read it through
 * `filterFullyQueued`, and a null one means "still behind the gate".
 *
 * The relays now stamp it themselves — they take the `InFlightEntry` as a
 * REQUIRED parameter — so for anything that goes through a relay, the type
 * checker is the guard and this test has nothing to add. It used to be the
 * only guard, back when the relay took an optional `onStarted` callback, and
 * the tool-approval resume shipped without one: it held the GPU and streamed
 * while every reader reported it as waiting in line, permanently, since the
 * client deliberately lets server truth win on activity. An optional hook
 * nobody is required to pass is not a contract.
 *
 * What remains are the two cases the type checker can't see, and both are the
 * same shape — a route that acquires a slot WITHOUT a relay doing it:
 *
 *  - it calls `acquireEndpointSlot` itself (the synchronous JSON send path does,
 *    and stamps by hand right after), or
 *  - it reaches no relay at all.
 *
 * Either way the route owns the stamp, and this checks it at least knows the
 * field exists. Deliberately file-level: matching a stamp to a particular
 * acquisition would need real flow analysis, and the cheap question already
 * catches the failure that matters — a route that gates its own generation and
 * never records when the gate opened.
 *
 * What it does NOT check: that a relay, having been handed the entry, actually
 * writes to it. That is a runtime property, and it is asserted directly in
 * `image-relay.test.ts`, `video-relay.test.ts` and `relay-tool-loop.test.ts`,
 * which hand a real entry to each relay and read the stamp back out.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROUTES = resolve(__dirname, '../../src/routes');

/** Calling one of these forces the entry to be passed — the param is required,
 *  and the relay does the stamping. */
const RELAYS = ['startStreamingRelay(', 'startMediaRelay(', 'startImageRelay(', 'startVideoRelay('];

function serverFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...serverFiles(full));
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

describe('in-flight registration', () => {
	it('leaves no route that registers a generation without a way to stamp it', () => {
		const offenders = serverFiles(ROUTES)
			.filter((file) => {
				const src = readFileSync(file, 'utf8');
				if (!src.includes('registerInFlight(')) return false;
				// Owns at least one acquisition a relay isn't doing for it — either it
				// gates directly, or it never reaches a relay at all.
				const ownsAnAcquisition =
					src.includes('acquireEndpointSlot(') || !RELAYS.some((call) => src.includes(call));
				if (!ownsAnAcquisition) return false;
				return !src.includes('generationStartedAt');
			})
			.map((file) => relative(ROUTES, file));

		// A route here registers an entry the sidebar will read, takes a slot
		// without a relay stamping it, and never records when the gate opened — so
		// its conversation reports as queued for the entire generation. Either
		// route it through a relay, or assign `generationStartedAt` straight after
		// `acquireEndpointSlot` resolves.
		expect(offenders).toEqual([]);
	});
});
