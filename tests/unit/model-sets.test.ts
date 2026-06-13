/**
 * The model-sets helpers are thin fetch wrappers around the preferences
 * PATCH, plus one pure merge function. Test the payload the wire sees (set
 * construction, name trimming, no-op guards) and the merge de-dupe semantics
 * — the kind of "obvious" logic a future refactor quietly gets wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedModelSet } from '$lib/types/api';

const mocks = vi.hoisted(() => ({
	invalidateAll: vi.fn(async () => {}),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock('$app/navigation', () => ({
	invalidateAll: mocks.invalidateAll,
}));

vi.mock('$lib/toast.svelte', () => ({
	toast: {
		error: mocks.toastError,
		success: mocks.toastSuccess,
	},
}));

import { deleteModelSet, mergeModelSet, saveModelSet } from '$lib/model-sets';

/** Capture the parsed modelSets body of the most recent fetch call. */
function capturedSets(): SavedModelSet[] {
	const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
	const init = call[1] as RequestInit;
	const body = JSON.parse(init.body as string) as { modelSets: SavedModelSet[] };
	return body.modelSets;
}

beforeEach(() => {
	mocks.invalidateAll.mockClear();
	mocks.toastError.mockClear();
	mocks.toastSuccess.mockClear();
	global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as never;
	// Deterministic ids so we can assert the saved-set payload.
	vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('saveModelSet', () => {
	it('appends a new set with a generated id, trimmed name, copied models', async () => {
		await saveModelSet([], '  Favorite Image Models  ', [
			{ modelId: 'fal::flux', count: 2 },
			{ modelId: 'openai::dall-e-3', count: 1 },
		]);
		expect(capturedSets()).toEqual([
			{
				id: 'fixed-uuid',
				name: 'Favorite Image Models',
				models: [
					{ modelId: 'fal::flux', count: 2 },
					{ modelId: 'openai::dall-e-3', count: 1 },
				],
			},
		]);
	});

	it('preserves existing sets and appends to the end', async () => {
		const existing: SavedModelSet[] = [
			{ id: 'old', name: 'Old', models: [{ modelId: 'a', count: 1 }] },
		];
		await saveModelSet(existing, 'New', [{ modelId: 'b', count: 1 }]);
		expect(capturedSets().map((s) => s.id)).toEqual(['old', 'fixed-uuid']);
	});

	it('hits PATCH /api/user/preferences with JSON content type', async () => {
		await saveModelSet([], 'X', [{ modelId: 'a', count: 1 }]);
		const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
		expect(call[0]).toBe('/api/user/preferences');
		const init = call[1] as RequestInit;
		expect(init.method).toBe('PATCH');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('no-ops (no fetch) on a blank name', async () => {
		await saveModelSet([], '   ', [{ modelId: 'a', count: 1 }]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('no-ops (no fetch) on empty selections', async () => {
		await saveModelSet([], 'Name', []);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('triggers invalidateAll on 2xx and shows no toast', async () => {
		await saveModelSet([], 'X', [{ modelId: 'a', count: 1 }]);
		expect(mocks.invalidateAll).toHaveBeenCalledOnce();
		expect(mocks.toastError).not.toHaveBeenCalled();
	});

	it('shows an error toast and does NOT invalidate on non-ok response', async () => {
		global.fetch = vi.fn(async () => new Response('{"message":"bad"}', { status: 400 })) as never;
		await saveModelSet([], 'X', [{ modelId: 'a', count: 1 }]);
		expect(mocks.toastError).toHaveBeenCalledOnce();
		expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't update model sets/i);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();
	});

	it('shows an error toast on thrown fetch (network failure)', async () => {
		global.fetch = vi.fn(async () => {
			throw new Error('network down');
		}) as never;
		await saveModelSet([], 'X', [{ modelId: 'a', count: 1 }]);
		expect(mocks.toastError).toHaveBeenCalledOnce();
		expect(mocks.toastError.mock.calls[0][0]).toMatch(/network down/);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();
	});
});

describe('deleteModelSet', () => {
	it('removes the set by id and PATCHes the remainder', async () => {
		const sets: SavedModelSet[] = [
			{ id: 'a', name: 'A', models: [{ modelId: 'm', count: 1 }] },
			{ id: 'b', name: 'B', models: [{ modelId: 'n', count: 1 }] },
		];
		await deleteModelSet(sets, 'a');
		expect(capturedSets().map((s) => s.id)).toEqual(['b']);
	});

	it('emits an empty array when removing the only set', async () => {
		await deleteModelSet([{ id: 'solo', name: 'S', models: [{ modelId: 'm', count: 1 }] }], 'solo');
		expect(capturedSets()).toEqual([]);
	});
});

describe('mergeModelSet (pure)', () => {
	it('appends the set models that are not already in the cart', () => {
		const cart = [{ modelId: 'a', count: 1 }];
		const set: SavedModelSet = {
			id: 's',
			name: 'S',
			models: [
				{ modelId: 'b', count: 2 },
				{ modelId: 'c', count: 1 },
			],
		};
		expect(mergeModelSet(cart, set)).toEqual([
			{ modelId: 'a', count: 1 },
			{ modelId: 'b', count: 2 },
			{ modelId: 'c', count: 1 },
		]);
	});

	it('keeps the existing cart entry on a modelId collision (no count compounding)', () => {
		const cart = [{ modelId: 'a', count: 3 }];
		const set: SavedModelSet = {
			id: 's',
			name: 'S',
			models: [
				{ modelId: 'a', count: 1 },
				{ modelId: 'b', count: 1 },
			],
		};
		expect(mergeModelSet(cart, set)).toEqual([
			{ modelId: 'a', count: 3 },
			{ modelId: 'b', count: 1 },
		]);
	});

	it('merging into an empty cart yields the set models verbatim', () => {
		const set: SavedModelSet = {
			id: 's',
			name: 'S',
			models: [{ modelId: 'a', count: 2 }],
		};
		expect(mergeModelSet([], set)).toEqual([{ modelId: 'a', count: 2 }]);
	});

	it('does not mutate the input cart', () => {
		const cart = [{ modelId: 'a', count: 1 }];
		const set: SavedModelSet = { id: 's', name: 'S', models: [{ modelId: 'b', count: 1 }] };
		mergeModelSet(cart, set);
		expect(cart).toEqual([{ modelId: 'a', count: 1 }]);
	});
});
