import { describe, expect, it } from 'vitest';
import { imageAttachment, capabilityPill, acceptsImageInput } from '$lib/model-capabilities';

describe('imageAttachment', () => {
	// The tri-state from openai-api-bridge/docs/model-capabilities.md. Absence is
	// "unknown", NEVER a denial — a passthrough upstream reports nothing.
	it('is "unknown" when the field is absent or empty', () => {
		expect(imageAttachment({})).toBe('unknown');
		expect(imageAttachment({ capabilities: [] })).toBe('unknown');
	});

	it('is "optional" when both text and image inputs are accepted', () => {
		expect(imageAttachment({ capabilities: ['text-to-image', 'image-to-image'] })).toBe('optional');
		expect(imageAttachment({ capabilities: ['text-to-video', 'image-to-video'] })).toBe('optional');
	});

	it('is "required" for image-input-only models', () => {
		expect(imageAttachment({ capabilities: ['image-to-image'] })).toBe('required');
		expect(imageAttachment({ capabilities: ['image-to-video'] })).toBe('required');
	});

	it('is "unsupported" for text-input-only models', () => {
		expect(imageAttachment({ capabilities: ['text-to-image'] })).toBe('unsupported');
		expect(imageAttachment({ capabilities: ['text-to-video'] })).toBe('unsupported');
	});

	it('matches on the {input}-to- prefix, so a new output modality still counts', () => {
		// A hypothetical future output modality must not read as unsupported.
		expect(imageAttachment({ capabilities: ['image-to-model3d'] })).toBe('required');
		expect(imageAttachment({ capabilities: ['text-to-model3d', 'image-to-model3d'] })).toBe(
			'optional',
		);
	});
});

describe('acceptsImageInput', () => {
	it('is true when any image-to-* route is present (vision chat, i2i, i2v)', () => {
		expect(acceptsImageInput(['text-to-text', 'image-to-text'])).toBe(true);
		expect(acceptsImageInput(['image-to-image'])).toBe(true);
		expect(acceptsImageInput(['text-to-video', 'image-to-video'])).toBe(true);
	});

	it('is false for text-input-only or absent capabilities', () => {
		expect(acceptsImageInput(['text-to-text'])).toBe(false);
		expect(acceptsImageInput(['text-to-image'])).toBe(false);
		expect(acceptsImageInput(undefined)).toBe(false);
		expect(acceptsImageInput([])).toBe(false);
	});
});

describe('capabilityPill', () => {
	it('returns null when there are no recognizable routes', () => {
		expect(capabilityPill(undefined)).toBeNull();
		expect(capabilityPill([])).toBeNull();
		// Fireworks-ish flat tokens carry no `-to-` and produce no pill.
		expect(capabilityPill(['image-generation', 'chat'])).toBeNull();
	});

	it('abbreviates a single route and tags its attachment requirement', () => {
		expect(capabilityPill(['text-to-image'])).toMatchObject({
			label: 'T2I',
			title: 'Text → image',
			attachment: 'unsupported',
		});
		expect(capabilityPill(['image-to-image'])).toMatchObject({
			label: 'I2I',
			title: 'Image → image',
			attachment: 'required',
		});
		expect(capabilityPill(['image-to-video'])).toMatchObject({
			label: 'I2V',
			title: 'Image → video',
			attachment: 'required',
		});
	});

	it('unions inputs into one pill in fixed T,I,V,A order (array order irrelevant)', () => {
		expect(capabilityPill(['image-to-image', 'text-to-image'])).toMatchObject({
			label: 'TI2I',
			title: 'Text or image → image',
			attachment: 'optional',
		});
		expect(capabilityPill(['text-to-video', 'image-to-video'])).toMatchObject({
			label: 'TI2V',
			title: 'Text or image → video',
			attachment: 'optional',
		});
	});

	it('tags attachment: required only when image is the sole input', () => {
		expect(capabilityPill(['image-to-image'])?.attachment).toBe('required');
		expect(capabilityPill(['text-to-image', 'image-to-image'])?.attachment).toBe('optional');
		expect(capabilityPill(['text-to-image'])?.attachment).toBe('unsupported');
	});
});
