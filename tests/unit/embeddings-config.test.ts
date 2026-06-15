import { afterEach, describe, expect, it, vi } from 'vitest';

// Control what the underlying config loader does without touching disk.
const loadMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/config', () => ({ loadEmbeddingsConfig: loadMock }));

import {
	resolveRelevanceConfig,
	_resetEmbeddingsConfigCacheForTests,
} from '$lib/server/retrieval/embeddings-config';

afterEach(() => {
	_resetEmbeddingsConfigCacheForTests();
	loadMock.mockReset();
});

describe('resolveRelevanceConfig resilience', () => {
	it('degrades to undefined (does not throw) when the config file is unreadable', () => {
		// Mirrors CI, where there is no config.toml on disk — loadEmbeddingsConfig
		// throws a ConfigError. recall_memory.isAvailable() runs this during tool
		// advertisement, so a throw here would break enumeration of every tool.
		loadMock.mockImplementation(() => {
			throw new Error('Could not read config file at /nope/config.toml: ENOENT');
		});
		expect(() => resolveRelevanceConfig()).not.toThrow();
		expect(resolveRelevanceConfig()).toBeUndefined();
	});

	it('returns undefined when no [embeddings] block is configured', () => {
		loadMock.mockReturnValue(null);
		expect(resolveRelevanceConfig()).toBeUndefined();
	});
});
