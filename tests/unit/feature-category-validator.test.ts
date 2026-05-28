import { describe, expect, it } from 'vitest';
import {
	FeatureCategoryValidationError,
	validateDisabledFeatures
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
	});

	it('deduplicates repeated entries', () => {
		expect(validateDisabledFeatures(['web', 'web'])).toEqual(['web']);
	});

	it('rejects non-array payloads', () => {
		for (const bad of ['web', 42, {}, true]) {
			expect(() => validateDisabledFeatures(bad)).toThrow(FeatureCategoryValidationError);
		}
	});

	it('rejects unknown category strings', () => {
		expect(() => validateDisabledFeatures(['memory'])).toThrow(
			/Unknown feature category.*memory/i
		);
		expect(() => validateDisabledFeatures(['web', 'totally-bogus'])).toThrow(
			FeatureCategoryValidationError
		);
	});

	it('rejects non-string entries', () => {
		expect(() => validateDisabledFeatures([42])).toThrow(FeatureCategoryValidationError);
		expect(() => validateDisabledFeatures([null])).toThrow(FeatureCategoryValidationError);
		expect(() => validateDisabledFeatures([{}])).toThrow(FeatureCategoryValidationError);
	});
});
