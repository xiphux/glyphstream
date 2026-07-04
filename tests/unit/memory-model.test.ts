import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the config loader + endpoint registry without touching disk.
const loadMock = vi.hoisted(() => vi.fn());
const getEndpointMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/config', () => ({ loadMemoryModelConfig: loadMock }));
vi.mock('$lib/server/endpoints/registry', () => ({ getEndpoint: getEndpointMock }));

import { getMemoryModel, resetMemoryModel } from '$lib/server/tasks/memory-model';

const loaded = {
	model: 'gpu::qwen-32b',
	maxTokens: 1500,
	temperature: 0.2,
	activeHours: '02:00-06:00',
	timezone: 'UTC',
};

afterEach(() => {
	resetMemoryModel();
	loadMock.mockReset();
	getEndpointMock.mockReset();
});

describe('getMemoryModel', () => {
	it('returns null when no [memory_model] block is configured', () => {
		loadMock.mockReturnValue(null);
		expect(getMemoryModel()).toBeNull();
	});

	it('returns null when the named endpoint no longer resolves', () => {
		loadMock.mockReturnValue(loaded);
		getEndpointMock.mockReturnValue(undefined);
		expect(getMemoryModel()).toBeNull();
	});

	it('resolves endpoint + upstream id + knobs + schedule', () => {
		const endpoint = { id: 'gpu', baseUrl: 'http://gpu/v1', maxConcurrent: 1 };
		loadMock.mockReturnValue(loaded);
		getEndpointMock.mockReturnValue(endpoint);
		expect(getMemoryModel()).toEqual({
			endpoint,
			upstreamId: 'qwen-32b',
			maxTokens: 1500,
			temperature: 0.2,
			activeHours: '02:00-06:00',
			timezone: 'UTC',
		});
	});

	it('memoizes — a second call does not re-read config', () => {
		loadMock.mockReturnValue(null);
		getMemoryModel();
		getMemoryModel();
		expect(loadMock).toHaveBeenCalledTimes(1);
	});
});
