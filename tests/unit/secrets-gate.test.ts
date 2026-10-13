/** Boot gate: the server refuses to start on a missing or short secret. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSecrets } from '#lib/server/env.js';

const LONG = 'a'.repeat(32);

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('validateSecrets', () => {
	it('refuses an unset or blank AUTH_SECRET', () => {
		vi.stubEnv('AUTH_SECRET', '');
		expect(() => validateSecrets()).toThrow(/AUTH_SECRET is not set/);
		vi.stubEnv('AUTH_SECRET', '   ');
		expect(() => validateSecrets()).toThrow(/AUTH_SECRET is not set/);
	});

	it('refuses an AUTH_SECRET under 32 characters', () => {
		vi.stubEnv('AUTH_SECRET', 'x'.repeat(31));
		expect(() => validateSecrets()).toThrow(/31 characters; it must be at least 32/);
	});

	it('accepts a 32-character AUTH_SECRET with MCP_SECRET_KEY unset', () => {
		vi.stubEnv('AUTH_SECRET', LONG);
		vi.stubEnv('MCP_SECRET_KEY', '');
		expect(() => validateSecrets()).not.toThrow();
	});

	it('refuses a short MCP_SECRET_KEY when one is set', () => {
		vi.stubEnv('AUTH_SECRET', LONG);
		vi.stubEnv('MCP_SECRET_KEY', 'short');
		expect(() => validateSecrets()).toThrow(/MCP_SECRET_KEY is 5 characters/);
	});
});
