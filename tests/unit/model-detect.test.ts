import { describe, expect, it } from 'vitest';
import { detectKind, normalizeUpstreamModel } from '$lib/server/endpoints/models';

describe('detectKind', () => {
	describe('explicit fields (preferred)', () => {
		it('uses bridge convention `kind` field when present', () => {
			expect(detectKind({ id: 'x', kind: 'video' })).toBe('video');
			expect(detectKind({ id: 'x', kind: 'image' })).toBe('image');
		});

		it('ignores invalid `kind` values', () => {
			// @ts-expect-error testing runtime defensiveness
			expect(detectKind({ id: 'x', kind: 'audio' })).toBeNull();
		});

		it('uses Together.ai-style `type` field', () => {
			expect(detectKind({ id: 'x', type: 'embedding' })).toBe('embedding');
			expect(detectKind({ id: 'x', type: 'image' })).toBe('image');
			expect(detectKind({ id: 'x', type: 'language' })).toBe('chat');
		});

		it('uses Fireworks-style `capabilities` array', () => {
			expect(detectKind({ id: 'x', capabilities: ['image-generation'] })).toBe('image');
			expect(detectKind({ id: 'x', capabilities: ['chat'] })).toBe('chat');
		});

		it('uses OpenRouter-style architecture.output_modalities', () => {
			expect(
				detectKind({ id: 'x', architecture: { output_modalities: ['image'] } })
			).toBe('image');
			expect(
				detectKind({ id: 'x', architecture: { output_modalities: ['text'] } })
			).toBe('chat');
		});
	});

	describe('id substring patterns (fallback)', () => {
		it('matches video model families', () => {
			expect(detectKind({ id: 'sora-video-1' })).toBe('video');
			expect(detectKind({ id: 'comfyui/ltx-video-2b' })).toBe('video');
			expect(detectKind({ id: 'comfyui/wan-video' })).toBe('video');
			expect(detectKind({ id: 'kling-1.6' })).toBe('video');
			expect(detectKind({ id: 'runway-gen3' })).toBe('video');
		});

		it('matches image model families', () => {
			expect(detectKind({ id: 'dall-e-3' })).toBe('image');
			expect(detectKind({ id: 'comfyui/sdxl-base' })).toBe('image');
			expect(detectKind({ id: 'comfyui/flux-schnell' })).toBe('image');
			expect(detectKind({ id: 'midjourney-6' })).toBe('image');
			expect(detectKind({ id: 'comfyui/sd3-medium' })).toBe('image');
		});

		it('matches embedding model families via "embed" substring', () => {
			expect(detectKind({ id: 'text-embedding-3-large' })).toBe('embedding');
			expect(detectKind({ id: 'voyage-embed-2' })).toBe('embedding');
		});

		it('returns null for ambiguously-named models', () => {
			expect(detectKind({ id: 'gpt-4' })).toBeNull();
			expect(detectKind({ id: 'llama-3-70b' })).toBeNull();
			expect(detectKind({ id: 'random-name' })).toBeNull();
		});
	});

	describe('precedence', () => {
		it('explicit `kind` beats id substring (e.g. "image" in name but kind=chat)', () => {
			// Hypothetical "image-captioning-llm" type model.
			expect(detectKind({ id: 'comfyui/sdxl-prompter', kind: 'chat' })).toBe('chat');
		});

		it('`type` field beats id substring', () => {
			expect(detectKind({ id: 'sora-1', type: 'chat' })).toBe('chat');
		});
	});
});

describe('normalizeUpstreamModel', () => {
	it('builds a ModelEntry with prefixed id + kindKnown=true when detected', () => {
		const e = normalizeUpstreamModel('bridge', { id: 'gpt-4o', kind: 'chat' });
		expect(e.id).toBe('bridge::gpt-4o');
		expect(e.endpointId).toBe('bridge');
		expect(e.upstreamId).toBe('gpt-4o');
		expect(e.kind).toBe('chat');
		expect(e.kindKnown).toBe(true);
	});

	it('falls back to chat with kindKnown=false when no signal', () => {
		const e = normalizeUpstreamModel('bridge', { id: 'random-thing' });
		expect(e.kind).toBe('chat');
		expect(e.kindKnown).toBe(false);
	});

	it('uses display_name if set, otherwise the upstream id', () => {
		expect(
			normalizeUpstreamModel('bridge', { id: 'gpt-4o', display_name: 'GPT-4o' }).displayName
		).toBe('GPT-4o');
		expect(normalizeUpstreamModel('bridge', { id: 'gpt-4o' }).displayName).toBe('gpt-4o');
	});

	it('extracts owned_by when set, null when missing', () => {
		expect(
			normalizeUpstreamModel('bridge', { id: 'x', owned_by: 'comfyui' }).ownedBy
		).toBe('comfyui');
		expect(normalizeUpstreamModel('bridge', { id: 'x' }).ownedBy).toBeNull();
	});
});
