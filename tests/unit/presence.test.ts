/**
 * Tests for the ephemeral cross-device viewer presence registry that gates
 * push suppression (`push/presence.ts`).
 *
 * Locks the behavior notifyConversationComplete relies on:
 *   - a visible viewer marks a conversation as being viewed
 *   - `visible:false` clears immediately (blur / thread-switch / unload)
 *   - viewers age out at the TTL (crashed tab that never sent visible:false)
 *   - presence is keyed by userId first, so it can't cross users
 *   - viewers are independent per conversation and per viewerId
 *
 * `now` is injected explicitly so expiry is deterministic (no fake timers).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	PRESENCE_TTL_MS,
	isConversationBeingViewed,
	recordPresence,
	resetPresence,
} from '$lib/server/push/presence';

const USER = 'user-1';
const CONV = 'conv-1';
const VIEWER = 'viewer-a';
const T0 = 1_000_000;

beforeEach(() => resetPresence());

describe('isConversationBeingViewed', () => {
	it('is false for a conversation nobody is viewing', () => {
		expect(isConversationBeingViewed(USER, CONV, T0)).toBe(false);
	});

	it('is true while a visible viewer is present', () => {
		recordPresence(USER, CONV, VIEWER, true, T0);
		expect(isConversationBeingViewed(USER, CONV, T0)).toBe(true);
	});

	it('stays viewed right up to the TTL and expires after it', () => {
		recordPresence(USER, CONV, VIEWER, true, T0);
		// Expiry is exclusive: expiresAt === now still counts as expired.
		expect(isConversationBeingViewed(USER, CONV, T0 + PRESENCE_TTL_MS - 1)).toBe(true);
		expect(isConversationBeingViewed(USER, CONV, T0 + PRESENCE_TTL_MS)).toBe(false);
	});

	it('a heartbeat refreshes the TTL', () => {
		recordPresence(USER, CONV, VIEWER, true, T0);
		recordPresence(USER, CONV, VIEWER, true, T0 + PRESENCE_TTL_MS - 1);
		// Would have expired on the original beat, but the refresh extended it.
		expect(isConversationBeingViewed(USER, CONV, T0 + PRESENCE_TTL_MS + 1)).toBe(true);
	});
});

describe('clearing', () => {
	it('visible:false clears the viewer immediately', () => {
		recordPresence(USER, CONV, VIEWER, true, T0);
		recordPresence(USER, CONV, VIEWER, false, T0 + 1);
		expect(isConversationBeingViewed(USER, CONV, T0 + 1)).toBe(false);
	});

	it('visible:false clears only the named viewer, not siblings on the same thread', () => {
		recordPresence(USER, CONV, 'viewer-a', true, T0);
		recordPresence(USER, CONV, 'viewer-b', true, T0);
		recordPresence(USER, CONV, 'viewer-a', false, T0 + 1);
		// viewer-b (a second tab/device) is still watching.
		expect(isConversationBeingViewed(USER, CONV, T0 + 1)).toBe(true);
	});

	it('a still-live viewer keeps the thread viewed after another expires', () => {
		recordPresence(USER, CONV, 'viewer-a', true, T0);
		recordPresence(USER, CONV, 'viewer-b', true, T0 + PRESENCE_TTL_MS - 1);
		// viewer-a has aged out, viewer-b has not.
		expect(isConversationBeingViewed(USER, CONV, T0 + PRESENCE_TTL_MS)).toBe(true);
	});
});

describe('isolation', () => {
	it('does not leak presence across users (griefing guard)', () => {
		// A client posting someone else's conversationId files it under its OWN
		// userId, so the real owner's check never matches.
		recordPresence('attacker', CONV, VIEWER, true, T0);
		expect(isConversationBeingViewed('victim', CONV, T0)).toBe(false);
	});

	it('does not leak presence across conversations', () => {
		recordPresence(USER, 'conv-a', VIEWER, true, T0);
		expect(isConversationBeingViewed(USER, 'conv-b', T0)).toBe(false);
	});
});
