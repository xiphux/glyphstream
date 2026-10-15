/**
 * The chat completion request a turn sends upstream, built in one place.
 *
 * The send path (`/messages`) and the approval resume (`/tool-approval`) both
 * call this for their first request and again before every tool-loop
 * iteration, so the two can't drift: CLAUDE.md's "the upstream payload is
 * rent, and its prefix must be stable" holds only if the same branch always
 * produces the same request. The context readout prices the same pieces;
 * `request-pricing-parity.test.ts` checks it against what this builds.
 *
 * Layout, in send order:
 * - `messages`: the system prompt, then the serialized branch, then (when a
 *   canvas is open) its current content as a tail system block. The tail is
 *   always last so an edit never disturbs the cached prefix.
 * - `tools`: the turn's base set, deduplicated, then `update_canvas` when a
 *   canvas is open, then any tool the model searched up this turn — in that
 *   order, so tools[] only grows at the end within a turn.
 * - The conversation's sampling parameters, when it has them.
 * - `stream_options.include_usage`, because streaming omits `usage` otherwise
 *   and the UI reports conversation size from it. (`stream: true` itself is
 *   set by the endpoint client.)
 */
import type { ChatMessage, CustomModelParameters, FeatureCategory } from '#lib/types/api.js';
import type { ChatCompletionRequest } from '../endpoints/client';
import { serializeBranchForUpstream, type MediaUrlResolver } from '../endpoints/serialize-upstream';
import { resolveActivatedToolDefs, type OpenAIToolDefinition } from '../tools';
import { augmentRequestForCanvas } from './tool-context';
import { dedupeToolDefs } from './tool-search-context';

export interface UpstreamRequestInput {
	conversationId: string;
	userId: string;
	/** The upstream's own model id (the part after `endpoint::`). */
	upstreamModelId: string;
	/** The active branch, in the `serialization` projection. */
	branch: ChatMessage[];
	/** The turn's composed system prompt (`buildChatToolContext`). */
	systemPrompt: string | null;
	/** The turn's base tool list (`buildChatToolContext`). */
	baseToolDefs: OpenAIToolDefinition[];
	/** Tools the model searched up earlier in this turn, promoted into tools[]. */
	activatedToolNames?: readonly string[];
	parameters: CustomModelParameters | null | undefined;
	disabledFeatures: readonly FeatureCategory[];
	supportsTools: boolean;
	resolveMediaDataUrl: MediaUrlResolver;
}

export async function buildUpstreamRequest(
	input: UpstreamRequestInput,
): Promise<ChatCompletionRequest> {
	const request: ChatCompletionRequest = {
		model: input.upstreamModelId,
		messages: await serializeBranchForUpstream(
			input.branch,
			input.resolveMediaDataUrl,
			input.systemPrompt,
		),
	};

	const baseTools = dedupeToolDefs(input.baseToolDefs);
	if (baseTools.length > 0) {
		request.tools = baseTools;
		request.tool_choice = 'auto';
	}

	// Only the fields the chat-completions API understands.
	const p = input.parameters;
	if (p?.temperature !== undefined) request.temperature = p.temperature;
	if (p?.top_p !== undefined) request.top_p = p.top_p;
	if (p?.max_tokens !== undefined) request.max_tokens = p.max_tokens;

	const withCanvas = augmentRequestForCanvas(request, {
		conversationId: input.conversationId,
		userId: input.userId,
		disabledFeatures: input.disabledFeatures,
		supportsTools: input.supportsTools,
	});

	// Tools searched up this turn go AFTER update_canvas, so a turn's tools[] only
	// ever grows at the end between iterations: [base, update_canvas] becomes
	// [base, update_canvas, searched]. Inserting them before update_canvas would
	// move it mid-turn and re-prefill the whole conversation on the next call.
	const activated = input.activatedToolNames ?? [];
	if (activated.length > 0) {
		const additions = resolveActivatedToolDefs([...activated], {
			excludeCategories: [...input.disabledFeatures],
		});
		if (additions.length > 0) {
			withCanvas.tools = dedupeToolDefs([...(withCanvas.tools ?? []), ...additions]);
			withCanvas.tool_choice = 'auto';
		}
	}
	return { ...withCanvas, stream_options: { include_usage: true } };
}

/**
 * A per-turn cache in front of a media resolver. Image bytes don't change for
 * the life of a conversation, so each media id is read and base64-encoded at
 * most once per turn, not once per tool-loop iteration.
 */
export function cachedMediaResolver(resolve: MediaUrlResolver): MediaUrlResolver {
	const cache = new Map<string, Promise<string>>();
	return (mediaId) => {
		let p = cache.get(mediaId);
		if (!p) {
			p = resolve(mediaId);
			cache.set(mediaId, p);
		}
		return p;
	};
}
