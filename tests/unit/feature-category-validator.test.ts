import { describe, expect, it } from 'vitest';
import {
	FeatureCategoryValidationError,
	validateDisabledFeatures,
} from '#lib/server/util/validate-features.js';
import { BUILTIN_FEATURE_CATEGORIES } from '#lib/types/api.js';

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

	it('accepts every built-in category', () => {
		expect(validateDisabledFeatures([...BUILTIN_FEATURE_CATEGORIES])).toEqual([
			...BUILTIN_FEATURE_CATEGORIES,
		]);
	});

	it('accepts any mcp: category, registered or not', () => {
		// No MCP server is configured here, so only the prefix lets these
		// through: a server dropped from config.toml mustn't make every stored
		// list naming it unsaveable.
		expect(validateDisabledFeatures(['mcp:filesystem'])).toEqual(['mcp:filesystem']);
		expect(validateDisabledFeatures(['web', 'mcp:linear'])).toEqual(['web', 'mcp:linear']);
	});

	it('rejects an unknown non-MCP category', () => {
		expect(() => validateDisabledFeatures(['made-up-category'])).toThrow(
			FeatureCategoryValidationError,
		);
		expect(() => validateDisabledFeatures(['web', 'wbe'])).toThrow(
			/Unknown feature category "wbe"/,
		);
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
