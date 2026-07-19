import { describe, expect, it } from 'vitest';
import {
	detectKind,
	extractContextWindow,
	normalizeUpstreamModel,
} from '$lib/server/endpoints/models';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

// (supportsTools fallback tests appended at the bottom)

function ep(overrides: Partial<LoadedEndpoint> = {}): LoadedEndpoint {
	return {
		id: 'bridge',
		displayName: 'Bridge',
		baseUrl: 'http://localhost/v1',
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: Infinity,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
		...overrides,
	};
}

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

		it('derives kind from bridge `capabilities` modality routes (output side)', () => {
			expect(detectKind({ id: 'x', capabilities: ['image-to-image'] })).toBe('image');
			expect(detectKind({ id: 'x', capabilities: ['text-to-image', 'image-to-image'] })).toBe(
				'image',
			);
			expect(detectKind({ id: 'x', capabilities: ['image-to-video'] })).toBe('video');
			expect(detectKind({ id: 'x', capabilities: ['text-to-text', 'image-to-text'] })).toBe('chat');
		});

		it('uses OpenRouter-style architecture.output_modalities', () => {
			expect(detectKind({ id: 'x', architecture: { output_modalities: ['image'] } })).toBe('image');
			expect(detectKind({ id: 'x', architecture: { output_modalities: ['text'] } })).toBe('chat');
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
		const e = normalizeUpstreamModel(ep(), { id: 'gpt-4o', kind: 'chat' });
		expect(e.id).toBe('bridge::gpt-4o');
		expect(e.endpointId).toBe('bridge');
		expect(e.upstreamId).toBe('gpt-4o');
		expect(e.kind).toBe('chat');
		expect(e.kindKnown).toBe(true);
	});

	it('falls back to chat with kindKnown=false when no signal', () => {
		const e = normalizeUpstreamModel(ep(), { id: 'random-thing' });
		expect(e.kind).toBe('chat');
		expect(e.kindKnown).toBe(false);
	});

	it('uses display_name if set, otherwise the upstream id', () => {
		expect(normalizeUpstreamModel(ep(), { id: 'gpt-4o', display_name: 'GPT-4o' }).displayName).toBe(
			'GPT-4o',
		);
		expect(normalizeUpstreamModel(ep(), { id: 'gpt-4o' }).displayName).toBe('gpt-4o');
	});

	it('extracts owned_by when set, null when missing', () => {
		expect(normalizeUpstreamModel(ep(), { id: 'x', owned_by: 'comfyui' }).ownedBy).toBe('comfyui');
		expect(normalizeUpstreamModel(ep(), { id: 'x' }).ownedBy).toBeNull();
	});

	describe('capabilities (bridge modality routes)', () => {
		it('carries through `{input}-to-{output}` routes', () => {
			const e = normalizeUpstreamModel(ep(), {
				id: 'nano-banana',
				kind: 'image',
				capabilities: ['text-to-image', 'image-to-image'],
			});
			expect(e.capabilities).toEqual(['text-to-image', 'image-to-image']);
		});

		it('filters out the Fireworks-ish flat vocabulary that shares the field', () => {
			// `image-generation` carries no `-to-`, so it is a kind signal only and
			// never leaks into the modality-routes field.
			const e = normalizeUpstreamModel(ep(), { id: 'x', capabilities: ['image-generation'] });
			expect(e.capabilities).toBeUndefined();
		});

		it('is undefined when the upstream omits the field', () => {
			expect(normalizeUpstreamModel(ep(), { id: 'x', kind: 'image' }).capabilities).toBeUndefined();
		});

		it('lowercases routes so a spec-violating upstream still classifies correctly', () => {
			// Lowercase happens before the shape filter, so an upper-cased separator
			// (`-TO-`) still passes and normalizes rather than dropping to unknown.
			const e = normalizeUpstreamModel(ep(), {
				id: 'x',
				kind: 'image',
				capabilities: ['Image-To-Image'],
			});
			expect(e.capabilities).toEqual(['image-to-image']);
		});
	});

	describe('group / groupKey', () => {
		it('defaults to endpoint.displayName / endpoint.id when groupBy="endpoint"', () => {
			const e = normalizeUpstreamModel(ep(), { id: 'x', owned_by: 'openrouter' });
			expect(e.group).toBe('Bridge');
			expect(e.groupKey).toBe('bridge');
		});

		it('uses owned_by for both group and groupKey when groupBy="owned_by"', () => {
			const e = normalizeUpstreamModel(ep({ groupBy: 'owned_by' }), {
				id: 'x',
				owned_by: 'openrouter',
			});
			expect(e.group).toBe('openrouter');
			expect(e.groupKey).toBe('openrouter');
		});

		it('falls back to endpoint.displayName when groupBy="owned_by" but model has no owned_by', () => {
			const e = normalizeUpstreamModel(ep({ groupBy: 'owned_by' }), { id: 'x' });
			expect(e.group).toBe('Bridge');
			expect(e.groupKey).toBe('bridge');
		});

		it('falls back to endpoint.displayName when groupBy="owned_by" and owned_by is empty', () => {
			const e = normalizeUpstreamModel(ep({ groupBy: 'owned_by' }), { id: 'x', owned_by: '' });
			expect(e.group).toBe('Bridge');
			expect(e.groupKey).toBe('bridge');
		});
	});

	describe('supportsTools resolution', () => {
		// Order: per-model upstream signal > endpoint config > false.
		it('defaults to false when neither layer says yes', () => {
			expect(normalizeUpstreamModel(ep(), { id: 'x' }).supportsTools).toBe(false);
		});

		it('uses endpoint.supportsTools when upstream omits the field', () => {
			expect(normalizeUpstreamModel(ep({ supportsTools: true }), { id: 'x' }).supportsTools).toBe(
				true,
			);
		});

		it('prefers the per-model upstream signal over the endpoint config', () => {
			// Endpoint says yes globally, but this specific model says no.
			expect(
				normalizeUpstreamModel(ep({ supportsTools: true }), { id: 'x', supports_tools: false })
					.supportsTools,
			).toBe(false);
			// Endpoint says no, but this model says yes.
			expect(
				normalizeUpstreamModel(ep({ supportsTools: false }), { id: 'x', supports_tools: true })
					.supportsTools,
			).toBe(true);
		});

		it('treats non-boolean supports_tools as missing (falls back to endpoint)', () => {
			// Defensive: a misbehaving upstream might send null / undefined.
			expect(
				normalizeUpstreamModel(ep({ supportsTools: true }), {
					id: 'x',
					supports_tools: null,
				}).supportsTools,
			).toBe(true);
		});
	});

	describe('contextWindow resolution', () => {
		// Order: per-model config override > per-model upstream signal >
		// endpoint config default > null.
		it('is null when no layer supplies one', () => {
			expect(normalizeUpstreamModel(ep(), { id: 'x' }).contextWindow).toBeNull();
		});

		it('uses endpoint.contextWindow when upstream exposes nothing', () => {
			expect(normalizeUpstreamModel(ep({ contextWindow: 8192 }), { id: 'x' }).contextWindow).toBe(
				8192,
			);
		});

		it('prefers the per-model upstream signal over the endpoint default', () => {
			expect(
				normalizeUpstreamModel(ep({ contextWindow: 8192 }), {
					id: 'x',
					meta: { n_ctx: 40960 },
				}).contextWindow,
			).toBe(40960);
		});

		it('a per-model config override wins over auto-detect and the endpoint default', () => {
			expect(
				normalizeUpstreamModel(
					ep({ contextWindow: 8192, modelContextWindows: { 'Gemma4-26B': 32768 } }),
					// Auto-detect would say 40960, but the operator pinned this model.
					{ id: 'Gemma4-26B', meta: { n_ctx: 40960 } },
				).contextWindow,
			).toBe(32768);
		});

		it('keys the per-model override by the bare upstream id', () => {
			// Only the matching model gets the override; others fall through.
			const e = ep({ modelContextWindows: { 'Gemma4-26B': 32768 } });
			expect(normalizeUpstreamModel(e, { id: 'Gemma4-26B' }).contextWindow).toBe(32768);
			expect(normalizeUpstreamModel(e, { id: 'GLM-4.7-Flash' }).contextWindow).toBeNull();
		});
	});

	describe('promptStyle / promptHint resolution', () => {
		// Order: per-model config override > upstream field > null. Resolution is
		// KIND-AWARE: image models normalize against the image style set, video
		// models against the video set, everything else gets no style/hint.
		it('is null when no layer supplies them (image model)', () => {
			const e = normalizeUpstreamModel(ep(), { id: 'x', kind: 'image' });
			expect(e.promptStyle).toBeNull();
			expect(e.promptHint).toBeNull();
		});

		it('reads + normalizes the upstream prompt_style/prompt_hint fields (image)', () => {
			const e = normalizeUpstreamModel(ep(), {
				id: 'x',
				kind: 'image',
				prompt_style: 'danbooru', // loose alias
				prompt_hint: 'masterpiece, best quality',
			});
			expect(e.promptStyle).toBe('booru-tags');
			expect(e.promptHint).toBe('masterpiece, best quality');
		});

		it('reads + normalizes a VIDEO style against the video set', () => {
			const e = normalizeUpstreamModel(ep(), {
				id: 'ltx',
				kind: 'video',
				prompt_style: 'cinematic', // loose alias
				prompt_hint: 'end with an ambient sound cue',
			});
			expect(e.promptStyle).toBe('cinematic-prose');
			expect(e.promptHint).toBe('end with an ambient sound cue');
		});

		it('drops a style from the WRONG medium to null (image style on a video model)', () => {
			// The value validated at config load (image∪video), but the medium is
			// only known here — a mismatched style falls back to clarify-only.
			const e = normalizeUpstreamModel(ep(), {
				id: 'x',
				kind: 'video',
				prompt_style: 'booru-tags',
			});
			expect(e.promptStyle).toBeNull();
		});

		it('gives a chat model no style/hint even if upstream supplies them', () => {
			const e = normalizeUpstreamModel(ep(), {
				id: 'x',
				kind: 'chat',
				prompt_style: 'natural-language',
				prompt_hint: 'be verbose',
			});
			expect(e.promptStyle).toBeNull();
			expect(e.promptHint).toBeNull();
		});

		it('drops an unknown upstream prompt_style to null', () => {
			expect(
				normalizeUpstreamModel(ep(), { id: 'x', kind: 'image', prompt_style: 'photoreal' })
					.promptStyle,
			).toBeNull();
		});

		it('resolves a cross-medium alias against the model kind, not image-first', () => {
			// `structured`/`narrative`/`prose` are valid aliases in BOTH mediums but
			// canonicalize differently. Config stores the raw alias; normalization
			// here uses the model's kind, so a video model gets the VIDEO key — not
			// the image key an image-first canonicalization would have picked.
			expect(
				normalizeUpstreamModel(ep(), { id: 'wan', kind: 'video', prompt_style: 'structured' })
					.promptStyle,
			).toBe('structured-cinematic');
			expect(
				normalizeUpstreamModel(ep(), { id: 'ltx', kind: 'video', prompt_style: 'narrative' })
					.promptStyle,
			).toBe('cinematic-prose');
			// Same alias on an image model still resolves to the image key.
			expect(
				normalizeUpstreamModel(ep(), { id: 'ideo', kind: 'image', prompt_style: 'structured' })
					.promptStyle,
			).toBe('json');
		});

		it('resolves a raw config-override alias per-kind too (stored un-canonicalized)', () => {
			const e = normalizeUpstreamModel(ep({ modelPromptStyles: { 'wan-2.2': 'structured' } }), {
				id: 'wan-2.2',
				kind: 'video',
			});
			expect(e.promptStyle).toBe('structured-cinematic');
		});

		it('a per-model config override wins over the upstream field', () => {
			const e = normalizeUpstreamModel(
				ep({
					modelPromptStyles: { 'illustrious-xl': 'booru-tags' },
					modelPromptHints: { 'illustrious-xl': 'no score_N tags' },
				}),
				{
					id: 'illustrious-xl',
					kind: 'image',
					prompt_style: 'natural-language',
					prompt_hint: 'be verbose',
				},
			);
			expect(e.promptStyle).toBe('booru-tags');
			expect(e.promptHint).toBe('no score_N tags');
		});
	});
});

describe('extractContextWindow', () => {
	it('reads a normalized context_window first', () => {
		expect(extractContextWindow({ id: 'x', context_window: 32768 })).toBe(32768);
	});

	it('reads llama.cpp meta.n_ctx (loaded model)', () => {
		expect(extractContextWindow({ id: 'x', meta: { n_ctx: 40960 } })).toBe(40960);
	});

	it('ignores meta.n_ctx_train (trained ceiling, not the real window)', () => {
		// n_ctx_train is often many times the configured --ctx-size; using it
		// would badly overstate the budget. With only n_ctx_train present and
		// no n_ctx, there is no usable signal.
		expect(extractContextWindow({ id: 'x', meta: { n_ctx_train: 262144 } })).toBeNull();
	});

	it('reads vLLM max_model_len', () => {
		expect(extractContextWindow({ id: 'x', max_model_len: 16384 })).toBe(16384);
	});

	it('parses --ctx-size from a llama.cpp router status.args (cold model)', () => {
		expect(
			extractContextWindow({
				id: 'x',
				status: { args: ['/usr/bin/llama-server', '--alias', 'x', '--ctx-size', '65536'] },
			}),
		).toBe(65536);
	});

	it('parses the -c alias and the =value form', () => {
		expect(extractContextWindow({ id: 'x', status: { args: ['-c', '8192'] } })).toBe(8192);
		expect(extractContextWindow({ id: 'x', status: { args: ['--ctx-size=4096'] } })).toBe(4096);
	});

	it('prefers a clean numeric field over the argv parse', () => {
		expect(
			extractContextWindow({
				id: 'x',
				meta: { n_ctx: 40960 },
				status: { args: ['--ctx-size', '65536'] },
			}),
		).toBe(40960);
	});

	it('rejects non-positive / non-numeric values', () => {
		expect(extractContextWindow({ id: 'x', meta: { n_ctx: 0 } })).toBeNull();
		expect(extractContextWindow({ id: 'x', status: { args: ['--ctx-size', 'nope'] } })).toBeNull();
		expect(extractContextWindow({ id: 'x' })).toBeNull();
	});
});
