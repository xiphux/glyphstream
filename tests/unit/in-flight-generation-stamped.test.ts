/**
 * Every route that registers an in-flight generation must stamp
 * `generationStartedAt` when the concurrency gate hands it a slot.
 *
 * The field is the whole definition of "queued rather than running": the
 * sidebar's mark, the layout seed and the 5s poll all read it through
 * `filterFullyQueued`, and a null one means "still behind the gate". But the
 * registry doesn't set it and neither does the relay — each route stamps its own
 * entry, three of them through the relay's OPTIONAL `onStarted` callback. An
 * optional callback nobody is required to pass is not a contract, and the
 * tool-approval resume shipped without it: the resumed turn took the GPU and
 * streamed while every reader reported it as waiting in line, permanently, since
 * the client deliberately lets server truth win on activity.
 *
 * Nothing else catches this. It type-checks (the callback is optional), it
 * lints, and no runtime test covers it — the behaviour is correct in every way
 * except the one bit of bookkeeping, and the symptom is a wrong icon on a row
 * the user has usually navigated away from.
 *
 * Scoped to the file level on purpose: matching a stamp to a particular
 * `registerInFlight` call would need real flow analysis, and the useful question
 * is the cheap one — does this route know the field exists at all? A route that
 * registers an entry and never mentions `generationStartedAt` has certainly
 * forgotten it. (`messages/+server.ts` registers once and stamps on four
 * branches, which is why per-call matching would be the wrong shape here.)
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROUTES = resolve(__dirname, '../../src/routes');

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
	it('stamps generationStartedAt in every route that registers a generation', () => {
		const offenders = serverFiles(ROUTES)
			.filter((file) => {
				const src = readFileSync(file, 'utf8');
				return src.includes('registerInFlight(') && !src.includes('generationStartedAt');
			})
			.map((file) => relative(ROUTES, file));

		// A route here registers an entry the sidebar will read and never records
		// when the gate granted it a slot, so its conversation reports as queued
		// for the entire generation. Add the stamp — `onStarted` for a relay path,
		// or straight after `acquireEndpointSlot` resolves on a synchronous one.
		expect(offenders).toEqual([]);
	});
});
