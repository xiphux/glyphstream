/**
 * A standalone `InFlightEntry` for relay tests.
 *
 * The relays take the registry entry itself (not a callback) so that stamping
 * `generationStartedAt` on slot acquisition cannot be forgotten by a caller —
 * which means every relay test now has to supply one. Built by hand rather than
 * through `registerInFlight` so a test doesn't have to enrol in the module-level
 * registry, and reset it, just to exercise a relay.
 *
 * Returned live, so a test can assert on `generationStartedAt` afterwards: the
 * relay writing it is the observable contract, and asserting on this object is
 * how you check the gate handover was recorded.
 */

import type { InFlightEntry } from '$lib/server/streaming/in-flight';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

export function inFlightEntryStub(endpoint: LoadedEndpoint): InFlightEntry {
	return {
		isTurn: true,
		controller: new AbortController(),
		endpoint,
		startedAt: Date.now(),
		branchKey: 'default',
		modelKind: null,
		modelId: null,
		// Null until the relay acquires its slot — which is the thing under test.
		generationStartedAt: null,
		sourceMediaId: null,
	};
}
