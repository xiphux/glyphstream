import { describe, expect, it, vi } from 'vitest';
import {
	validateCreateInput,
	validateParameters
} from '$lib/server/custom-models/validate';

// Stub the endpoint registry so the validator's "is this a known endpoint?"
// check has predictable input. Otherwise validateCreateInput would try to
// load config.toml from disk.
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (id: string) =>
		id === 'bridge' ? { id: 'bridge', baseUrl: 'http://x', apiKey: null } : undefined
}));

describe('validateParameters', () => {
	it('returns null for null/undefined/non-object input', () => {
		expect(validateParameters(undefined)).toBeNull();
		expect(validateParameters(null)).toBeNull();
		// @ts-expect-error testing runtime behavior on bad input
		expect(validateParameters('not an object')).toBeNull();
	});

	it('returns null when no recognized fields are set', () => {
		// Keys we don't know about get stripped silently — schema can grow
		// without breaking older clients.
		// @ts-expect-error unknown key
		expect(validateParameters({ unknown_field: 5 })).toBeNull();
	});

	it('accepts temperature in [0, 2]', () => {
		expect(validateParameters({ temperature: 0 })).toEqual({ temperature: 0 });
		expect(validateParameters({ temperature: 1.4 })).toEqual({ temperature: 1.4 });
		expect(validateParameters({ temperature: 2 })).toEqual({ temperature: 2 });
	});

	it('rejects temperature outside [0, 2]', () => {
		expect(() => validateParameters({ temperature: -0.1 })).toThrow();
		expect(() => validateParameters({ temperature: 2.5 })).toThrow();
	});

	it('accepts top_p in [0, 1]', () => {
		expect(validateParameters({ top_p: 0.95 })).toEqual({ top_p: 0.95 });
	});

	it('rejects top_p outside [0, 1]', () => {
		expect(() => validateParameters({ top_p: 1.5 })).toThrow();
	});

	it('accepts positive integer max_tokens', () => {
		expect(validateParameters({ max_tokens: 2048 })).toEqual({ max_tokens: 2048 });
	});

	it('rejects non-integer or non-positive max_tokens', () => {
		expect(() => validateParameters({ max_tokens: 0 })).toThrow();
		expect(() => validateParameters({ max_tokens: -1 })).toThrow();
		expect(() => validateParameters({ max_tokens: 1.5 })).toThrow();
	});

	it('combines multiple parameters', () => {
		expect(validateParameters({ temperature: 0.7, top_p: 0.9, max_tokens: 1000 })).toEqual({
			temperature: 0.7,
			top_p: 0.9,
			max_tokens: 1000
		});
	});
});

describe('validateCreateInput', () => {
	const valid = {
		name: 'Coding Bot',
		baseEndpointId: 'bridge',
		baseModelId: 'gpt-4o'
	};

	it('accepts the minimum required fields', () => {
		const r = validateCreateInput(valid);
		expect(r.name).toBe('Coding Bot');
		expect(r.baseEndpointId).toBe('bridge');
		expect(r.baseModelId).toBe('gpt-4o');
		expect(r.description).toBeNull();
		expect(r.systemPrompt).toBeNull();
		expect(r.parameters).toBeNull();
	});

	it('trims whitespace on string fields', () => {
		const r = validateCreateInput({
			...valid,
			name: '  Coding Bot  ',
			description: '  for code  ',
			systemPrompt: '  Be concise  '
		});
		expect(r.name).toBe('Coding Bot');
		expect(r.description).toBe('for code');
		expect(r.systemPrompt).toBe('Be concise');
	});

	it('rejects empty name', () => {
		expect(() => validateCreateInput({ ...valid, name: '   ' })).toThrow();
	});

	it('rejects name over 200 chars', () => {
		expect(() => validateCreateInput({ ...valid, name: 'x'.repeat(201) })).toThrow();
	});

	it('rejects unknown endpoint', () => {
		expect(() =>
			validateCreateInput({ ...valid, baseEndpointId: 'no-such-endpoint' })
		).toThrow();
	});

	it('rejects empty baseModelId', () => {
		expect(() => validateCreateInput({ ...valid, baseModelId: '' })).toThrow();
	});

	it('normalizes empty optional strings to null', () => {
		const r = validateCreateInput({
			...valid,
			description: '   ',
			systemPrompt: ''
		});
		expect(r.description).toBeNull();
		expect(r.systemPrompt).toBeNull();
	});

	it('defaults defaultDisabledFeatures to [] when omitted', () => {
		const r = validateCreateInput(valid);
		expect(r.defaultDisabledFeatures).toEqual([]);
	});

	it('accepts a valid defaultDisabledFeatures array', () => {
		const r = validateCreateInput({ ...valid, defaultDisabledFeatures: ['personalization'] });
		expect(r.defaultDisabledFeatures).toEqual(['personalization']);
	});

	it('de-dupes defaultDisabledFeatures entries', () => {
		const r = validateCreateInput({
			...valid,
			defaultDisabledFeatures: ['personalization', 'personalization', 'web']
		});
		expect(r.defaultDisabledFeatures).toEqual(['personalization', 'web']);
	});

	it('accepts MCP-style category strings (validator widened for runtime-discovered servers)', () => {
		// Now that FeatureCategory is open at the type level so MCP servers
		// can contribute `mcp:<server-id>` categories at startup, the base
		// validator accepts any non-empty string. Strict checking against
		// the live MCP registry lands with the dynamic category surface.
		const r = validateCreateInput({
			...valid,
			defaultDisabledFeatures: ['personalization', 'mcp:filesystem']
		});
		expect(r.defaultDisabledFeatures).toEqual(['personalization', 'mcp:filesystem']);
	});

	it('rejects non-string entries in defaultDisabledFeatures', () => {
		expect(() =>
			validateCreateInput({
				...valid,
				// @ts-expect-error testing runtime defense against malformed input
				defaultDisabledFeatures: ['personalization', 123]
			})
		).toThrow();
	});

	it('rejects non-array defaultDisabledFeatures', () => {
		expect(() =>
			validateCreateInput({
				...valid,
				// @ts-expect-error testing runtime defense against malformed input
				defaultDisabledFeatures: 'personalization'
			})
		).toThrow();
	});
});
