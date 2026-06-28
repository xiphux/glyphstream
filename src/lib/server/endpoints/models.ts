/**
 * Shared model normalization. Used by /api/models and the (app) page loader
 * so the kind-detection logic lives in one place.
 *
 * Strategy: try multiple vendor conventions, fall back to id substring
 * patterns for clearly-named families, then to a default of `chat` with
 * `kindKnown: false` so the UI can show an "unknown kind" hint if it cares.
 */

import { isModelKind } from '$lib/types/api';
import type { ModelEntry, ModelKind, UpstreamModel } from '$lib/types/api';
import type { LoadedEndpoint } from './config';
import { formatModelId } from './model-id';
import { normalizeStyle } from '../streaming/prompt-styles';

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
	if (isModelKind(m.kind)) {
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
			id,
		)
	) {
		return 'image';
	}
	if (/embed/.test(id)) return 'embedding';

	return null;
}

/**
 * Pull a context-window size (in tokens) out of whatever vendor extension the
 * upstream happens to use. Returns null when no source gives a positive value.
 *
 * Order: explicit/normalized fields beat the argv parse. The OpenAI spec has
 * no context-size field, so every source here is a vendor extension:
 *  1. `context_window` — already-normalized (openai-api-bridge emits this).
 *  2. `meta.n_ctx` — llama.cpp's *configured* context (= `--ctx-size`), only
 *     present while the model is loaded. We deliberately ignore
 *     `meta.n_ctx_train` (the model's trained ceiling, often many times the
 *     server's real window — using it would badly overstate the budget).
 *  3. `max_model_len` — vLLM.
 *  4. `status.args` `--ctx-size`/`-c` — llama.cpp router mode, the only source
 *     available while the model is cold (it lists the child's launch argv).
 */
export function extractContextWindow(m: UpstreamModel): number | null {
	const positive = (v: unknown): number | null =>
		typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;

	const direct = positive(m.context_window) ?? positive(m.meta?.n_ctx) ?? positive(m.max_model_len);
	if (direct !== null) return direct;

	const args = m.status?.args;
	if (Array.isArray(args)) {
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (typeof a !== 'string') continue;
			// `--ctx-size N` / `-c N` (separate token) or `--ctx-size=N`.
			if (a === '--ctx-size' || a === '-c') {
				const n = positive(Number(args[i + 1]));
				if (n !== null) return n;
			}
			const eq = /^(?:--ctx-size|-c)=(\d+)$/.exec(a);
			if (eq) {
				const n = positive(Number(eq[1]));
				if (n !== null) return n;
			}
		}
	}
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

	// Tool-calling capability: prefer the per-model upstream signal (an
	// aggregating bridge sets this per backend model); fall back to the
	// endpoint's config flag; default to false. The model can explicitly
	// say `false` to opt out of an otherwise tool-enabled endpoint.
	const supportsTools =
		typeof m.supports_tools === 'boolean' ? m.supports_tools : endpoint.supportsTools;

	// Context window, most-specific source first:
	//   1. per-model config override (operator's explicit statement — wins
	//      even over auto-detect, e.g. when auto-detect can't fire behind the
	//      bridge or the operator wants a deliberate value);
	//   2. the per-model upstream signal (llama.cpp meta.n_ctx / router
	//      --ctx-size, vLLM max_model_len, bridge context_window);
	//   3. the endpoint-level blanket default for vendors that expose nothing
	//      (raw OpenAI, Groq, …);
	//   4. null when nobody knows.
	const contextWindow =
		endpoint.modelContextWindows[m.id] ?? extractContextWindow(m) ?? endpoint.contextWindow ?? null;

	// Prompt style + hint for image enhancement, most-specific source first:
	//   1. per-model config override (operator's explicit statement);
	//   2. the upstream-reported field (bridge meta.json `prompt_style` /
	//      `prompt_hint`);
	//   3. null.
	// The config value is already normalized to a canonical key at load time;
	// the upstream value is normalized here (it may be a loose alias).
	const promptStyle = endpoint.modelPromptStyles[m.id] ?? normalizeStyle(m.prompt_style) ?? null;
	const promptHint = endpoint.modelPromptHints[m.id] ?? (m.prompt_hint || null);

	return {
		id: formatModelId(endpoint.id, m.id),
		endpointId: endpoint.id,
		upstreamId: m.id,
		displayName: m.display_name && m.display_name.length > 0 ? m.display_name : m.id,
		ownedBy: owner,
		kind: detected ?? 'chat',
		kindKnown: detected !== null,
		group,
		groupKey,
		supportsTools,
		contextWindow,
		promptStyle,
		promptHint,
	};
}
