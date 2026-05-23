/**
 * toggleFavoriteModel is a thin wrapper, but the list-manipulation
 * semantics (insertion preserves order, removal preserves order,
 * idempotent toggle round-trips) are exactly the kind of "obvious"
 * logic that gets a refactor wrong six months from now. Test the
 * payload the wire sees, not the surrounding fetch wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	invalidateAll: vi.fn(async () => {}),
	toastError: vi.fn(),
	toastSuccess: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	invalidateAll: mocks.invalidateAll
}));

vi.mock('$lib/toast.svelte', () => ({
	toast: {
		error: mocks.toastError,
		success: mocks.toastSuccess
	}
}));

import { toggleFavoriteModel } from '$lib/favorite-models';

/** Capture the parsed body of the most recent fetch call. */
function capturedFavorites(): string[] {
	const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
	const init = call[1] as RequestInit;
	const body = JSON.parse(init.body as string) as { favoriteModels: string[] };
	return body.favoriteModels;
}

beforeEach(() => {
	mocks.invalidateAll.mockClear();
	mocks.toastError.mockClear();
	mocks.toastSuccess.mockClear();
	global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as never;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('toggleFavoriteModel — adding', () => {
	it('appends a new id to the end (preserves prior order)', async () => {
		await toggleFavoriteModel(['a', 'b'], 'c');
		expect(capturedFavorites()).toEqual(['a', 'b', 'c']);
	});

	it('handles the empty-starting-list case', async () => {
		await toggleFavoriteModel([], 'x');
		expect(capturedFavorites()).toEqual(['x']);
	});

	it('hits PATCH /api/user/preferences with JSON content type', async () => {
		await toggleFavoriteModel([], 'x');
		const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
		expect(call[0]).toBe('/api/user/preferences');
		const init = call[1] as RequestInit;
		expect(init.method).toBe('PATCH');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});
});

describe('toggleFavoriteModel — removing', () => {
	it('drops the id when already favorited', async () => {
		await toggleFavoriteModel(['a', 'b', 'c'], 'b');
		expect(capturedFavorites()).toEqual(['a', 'c']);
	});

	it('preserves the order of the remaining ids', async () => {
		await toggleFavoriteModel(['a', 'b', 'c', 'd'], 'c');
		expect(capturedFavorites()).toEqual(['a', 'b', 'd']);
	});

	it('emits an empty list when removing the only entry', async () => {
		await toggleFavoriteModel(['solo'], 'solo');
		expect(capturedFavorites()).toEqual([]);
	});

	it('round-trips: add then remove returns the original list', async () => {
		await toggleFavoriteModel(['a', 'b'], 'c');
		const afterAdd = capturedFavorites();
		await toggleFavoriteModel(afterAdd, 'c');
		expect(capturedFavorites()).toEqual(['a', 'b']);
	});
});

describe('toggleFavoriteModel — success path', () => {
	it('triggers invalidateAll on 2xx and shows no toast', async () => {
		await toggleFavoriteModel([], 'x');
		expect(mocks.invalidateAll).toHaveBeenCalledOnce();
		expect(mocks.toastError).not.toHaveBeenCalled();
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
	});
});

describe('toggleFavoriteModel — failure paths', () => {
	it('shows an error toast and does NOT invalidate on non-ok response', async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"validation failed"}', { status: 400 })
		) as never;
		await toggleFavoriteModel(['a'], 'b');
		expect(mocks.toastError).toHaveBeenCalledOnce();
		expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't update favorites/i);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();
	});

	it('shows an error toast on thrown fetch (network failure)', async () => {
		global.fetch = vi.fn(async () => {
			throw new Error('network down');
		}) as never;
		await toggleFavoriteModel(['a'], 'b');
		expect(mocks.toastError).toHaveBeenCalledOnce();
		expect(mocks.toastError.mock.calls[0][0]).toMatch(/network down/);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();
	});
});
