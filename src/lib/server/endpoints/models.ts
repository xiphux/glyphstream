/**
 * Shared model normalization. Used by /api/models and the (app) page loader
 * so the kind-detection logic lives in one place.
 *
 * Strategy: try multiple vendor conventions, fall back to id substring
 * patterns for clearly-named families, then to a default of `chat` with
 * `kindKnown: false` so the UI can show an "unknown kind" hint if it cares.
 */

import type { ModelEntry, ModelKind, UpstreamModel } from '$lib/types/api';
import type { LoadedEndpoint } from './config';
import { formatModelId } from './registry';

const VALID_KINDS: readonly ModelKind[] = ['chat', 'embedding', 'image', 'video'];

/**
 * Try multiple conventions to determine a model's kind. Returns null when
 * no signal is confident enough to pick.
 *
 * Order matters: explicit fields beat heuristics. Inside heuristics, we
 * prefer richer signals (OpenRouter's modalities array) over substring
 * patterns (which are inherently fragile).
 */
export function detectKind(m: UpstreamModel): ModelKind | null {
	// 1. openai-api-bridge convention: explicit `kind` field
	if (typeof m.kind === 'string' && (VALID_KINDS as readonly string[]).includes(m.kind)) {
		return m.kind;
	}

	// 2. Together.ai-style `type` field
	if (typeof m.type === 'string') {
		const t = m.type.toLowerCase();
		if (t === 'chat' || t === 'language' || t === 'chat.completion') return 'chat';
		if (t === 'embedding' || t === 'embeddings') return 'embedding';
		if (t === 'image' || t === 'image-generation') return 'image';
		if (t === 'video' || t === 'video-generation') return 'video';
		// "moderation" / "audio" / etc fall through — we don't model them yet.
	}

	// 3. Fireworks-style capabilities array
	if (Array.isArray(m.capabilities)) {
		const caps = m.capabilities.map((c) => c.toLowerCase());
		if (caps.includes('video-generation')) return 'video';
		if (caps.includes('image-generation')) return 'image';
		if (caps.includes('embedding')) return 'embedding';
		if (caps.includes('chat') || caps.includes('completion')) return 'chat';
	}

	// 4. OpenRouter-style architecture.output_modalities
	const outputs = m.architecture?.output_modalities;
	if (Array.isArray(outputs)) {
		const lower = outputs.map((s) => s.toLowerCase());
		if (lower.includes('video')) return 'video';
		if (lower.includes('image')) return 'image';
		if (lower.includes('embedding')) return 'embedding';
		if (lower.includes('text')) return 'chat';
	}

	// 5. Last resort: id substring patterns. Only for clearly-named families;
	// ambiguously-named models fall through to the default. Order: most
	// specific first.
	const id = m.id.toLowerCase();
	if (/(?:^|[/_-])(?:sora|veo|kling|runway|ltx[_-]?video|wan[_-]?video)/.test(id)) return 'video';
	if (
		/(?:^|[/_-])(?:dall[_-]?e|stable[_-]?diffusion|sdxl|sd[_-]?\d|flux|midjourney|imagen|ideogram|titan-image|playground)/.test(
			id
		)
	) {
		return 'image';
	}
	if (/embed/.test(id)) return 'embedding';

	return null;
}

export function normalizeUpstreamModel(endpoint: LoadedEndpoint, m: UpstreamModel): ModelEntry {
	const detected = detectKind(m);
	const owner = typeof m.owned_by === 'string' && m.owned_by.length > 0 ? m.owned_by : null;

	// When the endpoint opts into owned_by grouping AND the model actually
	// reports an owner, bucket by that. Otherwise (default mode, or
	// owned_by mode with no owner field) fall back to the endpoint's own
	// display name — which is also a UX upgrade over the previous code,
	// which used the raw endpoint id as the group label.
	const useOwner = endpoint.groupBy === 'owned_by' && owner !== null;
	const group = useOwner ? owner : endpoint.displayName;
	const groupKey = useOwner ? owner : endpoint.id;

	return {
		id: formatModelId(endpoint.id, m.id),
		endpointId: endpoint.id,
		upstreamId: m.id,
		displayName: m.display_name && m.display_name.length > 0 ? m.display_name : m.id,
		ownedBy: owner,
		kind: detected ?? 'chat',
		kindKnown: detected !== null,
		group,
		groupKey
	};
}
