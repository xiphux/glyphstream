import { describe, expect, it } from 'vitest';
import {
	FeatureCategoryValidationError,
	validateDisabledFeatures,
} from '$lib/server/util/feature-categories';

describe('validateDisabledFeatures', () => {
	it('returns [] for undefined / null / missing', () => {
		expect(validateDisabledFeatures(undefined)).toEqual([]);
		expect(validateDisabledFeatures(null)).toEqual([]);
	});

	it('returns [] for an empty array', () => {
		expect(validateDisabledFeatures([])).toEqual([]);
	});

	it('accepts a single known category', () => {
		expect(validateDisabledFeatures(['web'])).toEqual(['web']);
		expect(validateDisabledFeatures(['personalization'])).toEqual(['personalization']);
	});

	it('accepts multiple known categories together', () => {
		expect(validateDisabledFeatures(['web', 'personalization'])).toEqual([
			'web',
			'personalization',
		]);
	});

	it('deduplicates repeated entries', () => {
		expect(validateDisabledFeatures(['web', 'web'])).toEqual(['web']);
	});

	it('rejects non-array payloads', () => {
		for (const bad of ['web', 42, {}, true]) {
			expect(() => validateDisabledFeatures(bad)).toThrow(FeatureCategoryValidationError);
		}
	});

	it('accepts arbitrary non-empty category strings (widened for MCP server categories)', () => {
		// FeatureCategory is open at the type level so MCP-registered
		// categories like `mcp:filesystem` flow through unchanged. Strict
		// checking against the live registry of built-ins + connected MCP
		// servers lands with the dynamic category surface.
		expect(validateDisabledFeatures(['mcp:filesystem'])).toEqual(['mcp:filesystem']);
		expect(validateDisabledFeatures(['web', 'mcp:linear'])).toEqual(['web', 'mcp:linear']);
	});

	it('rejects empty strings', () => {
		expect(() => validateDisabledFeatures([''])).toThrow(FeatureCategoryValidationError);
	});

	it('rejects non-string entries', () => {
		expect(() => validateDisabledFeatures([42])).toThrow(FeatureCategoryValidationError);
		expect(() => validateDisabledFeatures([null])).toThrow(FeatureCategoryValidationError);
		expect(() => validateDisabledFeatures([{}])).toThrow(FeatureCategoryValidationError);
	});
});
