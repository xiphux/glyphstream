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
 * What remains is the case the type checker can't see: a route that registers
 * an entry and then does its own thing — the synchronous JSON send path already
 * acquires a slot and stamps by hand. So this asserts the weaker, still-useful
 * property that such a route knows the field exists. A route that registers an
 * entry, never reaches a relay, and never mentions `generationStartedAt` has
 * certainly forgotten it.
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
				if (RELAYS.some((call) => src.includes(call))) return false;
				return !src.includes('generationStartedAt');
			})
			.map((file) => relative(ROUTES, file));

		// A route here registers an entry the sidebar will read, reaches no relay
		// to stamp it, and never records when the gate granted it a slot — so its
		// conversation reports as queued for the entire generation. Either route it
		// through a relay, or assign `generationStartedAt` straight after
		// `acquireEndpointSlot` resolves.
		expect(offenders).toEqual([]);
	});
});
