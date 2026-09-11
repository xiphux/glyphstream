/**
 * Per-conversation in-flight registry. Tiny module, but the
 * "replace-and-abort prior entry" and "only clear if the slot still
 * holds *our* entry" semantics are easy to break in a refactor and
 * would silently drop cancellation guarantees. The fan-out support adds
 * N-per-conversation keying, which must not regress the single-entry
 * (default-branch) behavior.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import {
	clearInFlight,
	conversationFanoutAtCapacity,
	DEFAULT_BRANCH,
	filterFullyQueued,
	filterInFlight,
	getInFlightEntries,
	conversationTurnEntries,
	AVATAR_BRANCH,
	getAvatarDrawSince,
	getInFlightGeneratingSince,
	getInFlightSince,
	registerInFlight,
	resetInFlight,
} from '$lib/server/streaming/in-flight';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '$lib/fanout';

function endpoint(id: string): LoadedEndpoint {
	return {
		id,
		baseUrl: `https://${id}.example.com/v1`,
		displayName: id,
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30,
		maxConcurrent: Infinity,
	} as LoadedEndpoint;
}

afterEach(() => {
	resetInFlight();
});

describe('registerInFlight', () => {
	it('returns an entry with a fresh AbortController and current start time', () => {
		const before = Date.now();
		const entry = registerInFlight('c1', endpoint('a'));
		expect(entry.controller).toBeInstanceOf(AbortController);
		expect(entry.controller.signal.aborted).toBe(false);
		expect(entry.startedAt).toBeGreaterThanOrEqual(before);
		expect(entry.endpoint.id).toBe('a');
		expect(entry.branchKey).toBe(DEFAULT_BRANCH);
	});

	it('makes the entry retrievable by conversation id', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		expect(getInFlightEntries('c1')).toEqual([entry]);
	});

	it('aborts the prior entry when re-registering the same conversation+branch', () => {
		// UI guards against this but the registry defends in depth — without
		// it, two upstream calls could be racing for the same branch and the
		// cancel button would only know about the newer one.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		expect(first.controller.signal.aborted).toBe(true);
		expect(second.controller.signal.aborted).toBe(false);
		expect(getInFlightEntries('c1')).toEqual([second]);
	});
});

describe('fan-out: multiple branches per conversation', () => {
	it('keeps distinct branches side by side without aborting each other', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		const c = registerInFlight('c1', endpoint('m3'), 'b2');
		expect(a.controller.signal.aborted).toBe(false);
		expect(b.controller.signal.aborted).toBe(false);
		expect(c.controller.signal.aborted).toBe(false);
		expect(new Set(getInFlightEntries('c1'))).toEqual(new Set([a, b, c]));
	});

	it('clears one branch without disturbing the others', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		clearInFlight('c1', a);
		expect(getInFlightEntries('c1')).toEqual([b]);
	});

	it('re-registering one branch aborts only that branch', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		const a2 = registerInFlight('c1', endpoint('m1'), 'b0');
		expect(a.controller.signal.aborted).toBe(true);
		expect(b.controller.signal.aborted).toBe(false);
		expect(new Set(getInFlightEntries('c1'))).toEqual(new Set([a2, b]));
	});
});

describe('clearInFlight', () => {
	it('removes the entry when the slot still holds the matching entry', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', entry);
		expect(getInFlightEntries('c1')).toEqual([]);
	});

	it('does NOT clear when a newer entry has overwritten the slot', () => {
		// The recorder's finally-block calls clearInFlight with the entry
		// IT registered. If a newer turn has since taken the slot, clearing
		// would orphan the new generation's controller — its cancel button
		// would silently stop working. Guard against that.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', first);
		expect(getInFlightEntries('c1')).toEqual([second]);
	});

	it('is a no-op when the conversation has no entry', () => {
		const ghost = registerInFlight('c2', endpoint('a'));
		resetInFlight();
		expect(() => clearInFlight('c1', ghost)).not.toThrow();
	});
});

describe('getInFlightSince', () => {
	it('returns null when nothing is in flight', () => {
		expect(getInFlightSince('c1')).toBeNull();
	});

	it('returns the earliest start time across branches', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		// Force a known ordering rather than relying on wall-clock ties.
		a.startedAt = 1000;
		b.startedAt = 2000;
		expect(getInFlightSince('c1')).toBe(1000);
	});
});

describe('getInFlightGeneratingSince', () => {
	it('returns null when nothing is in flight', () => {
		expect(getInFlightGeneratingSince('c1')).toBeNull();
	});

	it('returns null while the turn is registered but still queued behind the gate', () => {
		// The bug this exists for: registration time is not generation time. A
		// turn waiting on a max_concurrent=1 endpoint is in flight (so
		// getInFlightSince is non-null) but has not started generating.
		registerInFlight('c1', endpoint('a'));
		expect(getInFlightSince('c1')).not.toBeNull();
		expect(getInFlightGeneratingSince('c1')).toBeNull();
	});

	it('returns the slot-acquisition time once the gate hands over', () => {
		const e = registerInFlight('c1', endpoint('a'));
		e.startedAt = 1000;
		e.generationStartedAt = 5000;
		expect(getInFlightGeneratingSince('c1')).toBe(5000);
	});

	it('returns the earliest start among branches that have one', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		registerInFlight('c1', endpoint('m3'), 'b2');
		a.generationStartedAt = 3000;
		b.generationStartedAt = 2000;
		expect(getInFlightGeneratingSince('c1')).toBe(2000);
	});

	it('ignores an avatar draw holding the GPU while the turn itself queues', () => {
		registerInFlight('c1', endpoint('a'));
		const draw = registerInFlight('c1', endpoint('a'), AVATAR_BRANCH, null, null, null, false);
		draw.generationStartedAt = 5000;
		expect(getInFlightGeneratingSince('c1')).toBeNull();
	});
});

describe('filterInFlight', () => {
	it('keeps only the ids that have a generation registered, in caller order', () => {
		registerInFlight('c1', endpoint('a'));
		registerInFlight('c3', endpoint('a'));
		expect(filterInFlight(['c1', 'c2', 'c3'])).toEqual(['c1', 'c3']);
	});

	it('never reports an id the caller did not ask about', () => {
		// The scoping contract: callers pass their own conversations, so a
		// generation belonging to someone else's conversation must not leak in
		// just because it happens to be running.
		registerInFlight('someone-elses', endpoint('a'));
		expect(filterInFlight(['mine'])).toEqual([]);
	});

	it('drops an id once its last branch clears', () => {
		const a = registerInFlight('c1', endpoint('a'), 'b0');
		const b = registerInFlight('c1', endpoint('a'), 'b1');
		clearInFlight('c1', a);
		expect(filterInFlight(['c1'])).toEqual(['c1']);
		clearInFlight('c1', b);
		expect(filterInFlight(['c1'])).toEqual([]);
	});

	it('returns an empty array for an empty input', () => {
		registerInFlight('c1', endpoint('a'));
		expect(filterInFlight([])).toEqual([]);
	});
});

describe('filterFullyQueued', () => {
	it('reports a conversation whose every branch is still behind the gate', () => {
		registerInFlight('c1', endpoint('a'), 'b0');
		registerInFlight('c1', endpoint('a'), 'b1');
		expect(filterFullyQueued(['c1'])).toEqual(['c1']);
	});

	it('drops it as soon as ONE branch acquires a slot', () => {
		registerInFlight('c1', endpoint('a'), 'b0');
		const b = registerInFlight('c1', endpoint('a'), 'b1');
		// What the relay does when the gate grants it a slot.
		b.generationStartedAt = Date.now();
		// A grid is queued only while all of it is: one branch on the GPU makes
		// the whole conversation the one that's working.
		expect(filterFullyQueued(['c1'])).toEqual([]);
	});

	it('does not report a conversation with nothing in flight', () => {
		// "Queued rather than generating", never "queued rather than idle" — an
		// idle conversation must not pick up a mark it has no business wearing.
		expect(filterFullyQueued(['c1'])).toEqual([]);
	});

	it('counts an avatar draw like any other branch', () => {
		// Matches filterInFlight, which deliberately includes side errands: the
		// row it marks is the same row, and a draw waiting at the gate is queued.
		registerInFlight('c1', endpoint('a'), AVATAR_BRANCH, null, null, null, false);
		expect(filterFullyQueued(['c1'])).toEqual(['c1']);
	});

	it('never reports an id the caller did not ask about', () => {
		registerInFlight('someone-elses', endpoint('a'));
		expect(filterFullyQueued(['mine'])).toEqual([]);
	});
});

describe('conversationFanoutAtCapacity', () => {
	it('is false below the cap, true once the cap is reached, and scoped per conversation', () => {
		expect(conversationFanoutAtCapacity('c1')).toBe(false);
		// Fill c1 to one below the cap — still accepting.
		for (let i = 0; i < MAX_FANOUT_BRANCHES_PER_CONVERSATION - 1; i++) {
			registerInFlight('c1', endpoint('e'), `b${i}`);
		}
		expect(conversationFanoutAtCapacity('c1')).toBe(false);
		// The branch that reaches the cap flips it.
		registerInFlight('c1', endpoint('e'), 'b-last');
		expect(conversationFanoutAtCapacity('c1')).toBe(true);
		// A different conversation is unaffected.
		expect(conversationFanoutAtCapacity('c2')).toBe(false);
	});
});

describe('resetInFlight', () => {
	it('aborts every entry across all conversations and branches', () => {
		const a = registerInFlight('c1', endpoint('e'), 'b0');
		const b = registerInFlight('c1', endpoint('e'), 'b1');
		const c = registerInFlight('c2', endpoint('e'));
		resetInFlight();
		expect(a.controller.signal.aborted).toBe(true);
		expect(b.controller.signal.aborted).toBe(true);
		expect(c.controller.signal.aborted).toBe(true);
		expect(getInFlightEntries('c1')).toEqual([]);
		expect(getInFlightEntries('c2')).toEqual([]);
	});
});

describe('conversationTurnEntries', () => {
	it("excludes an avatar draw from the conversation's turn", () => {
		// Two consumers ask "is the turn done": the fan-out recovery grid and the
		// aggregate notification. Counting a side errand makes the grid grow a
		// phantom column that blocks picking, and makes the notification never
		// fire — no branch ever finds the registry empty.
		const branch = registerInFlight('c1', endpoint('a'), 'br0', 'chat', 'e::m');
		// Registered exactly as the avatar route does: its own key AND isTurn=false.
		// The key alone is not what excludes it — the flag is, so the next side
		// errand is excluded by default rather than silently readmitted.
		const avatar = registerInFlight(
			'c1',
			endpoint('a'),
			AVATAR_BRANCH,
			'image',
			'e::img',
			null,
			false,
		);

		expect(new Set(getInFlightEntries('c1'))).toEqual(new Set([branch, avatar]));
		expect(conversationTurnEntries('c1')).toEqual([branch]);
	});

	it('is empty once only the avatar draw remains', () => {
		registerInFlight('c1', endpoint('a'), AVATAR_BRANCH, 'image', 'e::img', null, false);
		expect(conversationTurnEntries('c1')).toEqual([]);
	});

	it('still counts an entry that only carries a distinct key', () => {
		// A fan-out branch has its own key too — being non-default is not what
		// makes something a side errand.
		const branch = registerInFlight('c1', endpoint('a'), 'br7', 'chat', 'e::m');
		expect(conversationTurnEntries('c1')).toEqual([branch]);
	});
});

describe('getAvatarDrawSince', () => {
	// The two readings are complementary by design and the pair is the contract:
	// a draw must be invisible to the turn machinery (or it raises a phantom
	// "Generating…" bubble and wedges that poll) and visible to the header ring
	// (or a suspended draw silently disappears for the minutes it has left).
	it('reports a draw that getInFlightSince deliberately hides', () => {
		const before = Date.now();
		registerInFlight('c1', endpoint('a'), AVATAR_BRANCH, 'image', 'e::img', null, false);

		expect(getInFlightSince('c1')).toBeNull();
		expect(getAvatarDrawSince('c1')).toBeGreaterThanOrEqual(before);
	});

	it('is null for a conversation whose only work IS a turn', () => {
		registerInFlight('c1', endpoint('a'));
		expect(getInFlightSince('c1')).not.toBeNull();
		expect(getAvatarDrawSince('c1')).toBeNull();
	});

	it('is null for a conversation with nothing running', () => {
		expect(getAvatarDrawSince('nope')).toBeNull();
	});

	it('reports each conversation separately', () => {
		registerInFlight('c1', endpoint('a'), AVATAR_BRANCH, 'image', 'e::img', null, false);
		expect(getAvatarDrawSince('c2')).toBeNull();
	});

	it('goes back to null once the draw is cleared', () => {
		// The client's poll terminates only on null, so a lingering entry is a
		// permanently spinning ring and a permanently disabled Draw button.
		const avatar = registerInFlight(
			'c1',
			endpoint('a'),
			AVATAR_BRANCH,
			'image',
			'e::img',
			null,
			false,
		);
		clearInFlight('c1', avatar);
		expect(getAvatarDrawSince('c1')).toBeNull();
	});

	it('follows the superseding draw when a second one takes the slot', () => {
		const first = registerInFlight(
			'c1',
			endpoint('a'),
			AVATAR_BRANCH,
			'image',
			'e::img',
			null,
			false,
		);
		const second = registerInFlight(
			'c1',
			endpoint('a'),
			AVATAR_BRANCH,
			'image',
			'e::img',
			null,
			false,
		);
		expect(first.controller.signal.aborted).toBe(true);
		expect(getAvatarDrawSince('c1')).toBe(second.startedAt);

		// And the loser's clear is a no-op — identity-guarded, so the aborted
		// first draw's `finally` can't switch the ring off on the live second one.
		clearInFlight('c1', first);
		expect(getAvatarDrawSince('c1')).toBe(second.startedAt);
	});
});
