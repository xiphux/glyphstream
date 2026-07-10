/**
 * Route-handler tests for POST /api/conversations/[id]/messages. The
 * handler's setup window (between registerInFlight and the start*Relay /
 * sseResponse return) has several throwing awaits that would leak in-flight
 * registry entries without the outer try/catch block (finding A3). These
 * tests verify the fix by making a setup await throw and asserting the
 * registry is clean afterward — not just the HTTP response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInFlightEntries, resetInFlight } from '$lib/server/streaming/in-flight';

// ---- hoisted mocks --------------------------------------------------------

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	updateConversationModel: vi.fn<(...a: unknown[]) => unknown>(),
	createUserMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getEndpoint: vi.fn<(...a: unknown[]) => unknown>(),
	listAllModels: vi.fn<(...a: unknown[]) => unknown>(),
	logLevel: vi.fn<(...a: unknown[]) => string>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	updateConversationModel: (...a: unknown[]) => mocks.updateConversationModel(...a),
}));

vi.mock('$lib/server/messages/create-user-message', () => ({
	createUserMessage: (...a: unknown[]) => mocks.createUserMessage(...a),
}));

vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (...a: unknown[]) => mocks.getEndpoint(...a),
}));

vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: (...a: unknown[]) => mocks.listAllModels(...a),
}));

vi.mock('$lib/server/env', () => ({
	logLevel: (...a: unknown[]) => mocks.logLevel(...a),
}));

// ---- imports after mocks --------------------------------------------------

import { POST } from '../../src/routes/api/conversations/[id]/messages/+server';

// ---- helpers --------------------------------------------------------------

function endpointStub() {
	return {
		id: 'ep',
		baseUrl: 'https://example.com/v1',
		displayName: 'ep',
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30,
		maxConcurrent: Infinity,
		supportsTools: false,
	};
}

function userMessageStub() {
	return {
		id: 'um1',
		parts: [{ type: 'text' as const, text: 'hello' }],
	};
}

function call() {
	const url = new URL('http://x/api/conversations/c1/messages');
	const locals = { user: { id: 'u1' } };
	const request = new Request(url, { method: 'POST' });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return POST({ locals, params: { id: 'c1' }, request, url } as any);
}

// ---- setup / teardown -----------------------------------------------------

afterEach(() => {
	resetInFlight();
});

// ---- tests ----------------------------------------------------------------

describe('POST /messages — setup window cleanup (A3 fix)', () => {
	beforeEach(() => {
		mocks.logLevel.mockReturnValue('info');
		mocks.getConversationMeta.mockReturnValue({
			id: 'c1',
			modelId: 'ep::sd3',
			modelKind: 'image',
			endpointId: 'ep',
			title: null,
			activeLeafMessageId: null,
			systemPrompt: null,
			private: false,
			disabledFeatures: [],
		});
		mocks.createUserMessage.mockReturnValue(userMessageStub());
		mocks.getEndpoint.mockReturnValue(endpointStub());
	});

	it('clears the in-flight entry when listAllModels throws in the image branch', async () => {
		mocks.listAllModels.mockRejectedValue(new Error('upstream unavailable'));

		let caught = false;
		try {
			await call();
		} catch {
			caught = true;
		}

		// The handler threw (SvelteKit HttpError or raw Error propagated
		// out of the outer catch as a re-throw).
		expect(caught).toBe(true);

		// The critical assertion: the in-flight registry was drained
		// by the outer catch, not left leaking.
		expect(getInFlightEntries('c1')).toEqual([]);
	});
});
