/**
 * The unit suite must not read the developer's real ./config.toml.
 *
 * `vitest.config.ts` sets `env: { CONFIG_PATH: … }`, which reaches `configPath()`
 * only because env.ts reads `process.env` directly (see the note at its top). A
 * Kit env module like `$env/dynamic/private` is populated by the SvelteKit SERVER
 * at runtime and is an EMPTY object under vitest, so the setting never lands and
 * every read falls through to the './config.toml' fallback. Tests that don't fully
 * mock the config layer then behave one way on a dev machine (a real config, with
 * [search] and [embeddings] blocks) and another way in CI (no config at all).
 *
 * This test fails the moment config reads stop reaching that setting, rather than
 * letting the suite quietly read whatever happens to be on the machine running it.
 */
import { describe, expect, it } from 'vitest';
import { configPath } from '#lib/server/env.js';
import { loadEndpoints } from '#lib/server/endpoints/config.js';

describe('config isolation', () => {
	it("resolves CONFIG_PATH from vitest's env, not the './config.toml' fallback", () => {
		expect(configPath()).toBe('/glyphstream-test-no-such-config.toml');
	});

	it('sees no config at all, on any machine', () => {
		// The deterministic baseline every unmocked test is written against. (A dev
		// machine's real config.toml defines endpoints; this must still be empty.)
		expect(loadEndpoints()).toEqual([]);
	});
});
