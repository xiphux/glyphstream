/**
 * `GET /api/conversations/:id/context` — price the request this conversation
 * would send on its next turn, segment by segment.
 *
 * Deliberately mirrors the send handler's resolution (feature seal → persona vs.
 * snapshotted prompt → tool context → active branch) rather than reading a
 * cached figure, because the whole value of the number is that it's the same
 * assembly the model actually gets. It does NOT persist anything or advance the
 * conversation — this is a read-only probe.
 *
 * The one deviation from the send path is media: images are priced from the
 * `byte_size` column instead of being read off disk and base64-encoded, so
 * opening the panel on a thread full of screenshots costs a few row reads rather
 * than tens of megabytes of encoding.
 */
import { json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { walkActiveBranch } from '$lib/server/db/queries/messages';
import { getMediaForUser } from '$lib/server/db/queries/media';
import {
	getUserPreferences,
	PERSONA_PART_SEPARATOR,
} from '$lib/server/db/queries/user-preferences';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { listAllModels } from '$lib/server/endpoints/list-models';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { resolveDisabledFeatures } from '$lib/server/chat/private-seal';
import { composePersonaPromptParts } from '$lib/server/chat/persona-context';
import { buildChatToolContext } from '$lib/server/chat/tool-context';
import { dedupeToolDefs } from '$lib/server/chat/tool-search-context';
import { buildContextBreakdown, type MediaSize } from '$lib/server/chat/context-breakdown';
import { cachedVisionVariantSize } from '$lib/server/media/vision-variant';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const userId = locals.user.id;

	const meta = requireFound(getConversationMeta(params.id, userId), 'Conversation not found');
	const disabledFeatures = resolveDisabledFeatures(meta);

	// Resolve tool support the same way the send path does — a model that can't
	// take tools is sent neither the definitions nor the skills catalog, and
	// pricing them here would overstate the payload by a couple thousand tokens.
	const parsed = parseModelId(meta.modelId);
	const endpoint = parsed ? getEndpoint(parsed.endpointId) : null;
	const modelEntry = parsed
		? (await listAllModels()).find(
				(m) => m.endpointId === parsed.endpointId && m.upstreamId === parsed.upstreamId,
			)
		: undefined;
	const supportsTools = modelEntry?.supportsTools ?? endpoint?.supportsTools ?? false;

	// Same precedence as the send path: a snapshotted custom-model prompt wins
	// outright, otherwise the persona prompt is recomposed from current prefs.
	const prefs = getUserPreferences(userId);
	const customSystemPrompt = meta.systemPrompt;
	const personaParts =
		customSystemPrompt === null ? composePersonaPromptParts(prefs, userId, disabledFeatures) : [];

	// Rejoin the parts into the same string the send path composes. `null` (not
	// `''`) when there are no sections, matching `composePersonaPrompt` — the
	// catalog/hint appenders branch on it.
	const baseSystemPrompt =
		customSystemPrompt ??
		(personaParts.length > 0 ? personaParts.map((p) => p.text).join(PERSONA_PART_SEPARATOR) : null);

	// `columns: 'all'`, NOT the send path's `'serialization'`. That projection
	// deliberately skips `tokens_in` / `tokens_out` (see walkActiveBranch), which
	// the send path never needs — but they are exactly what this endpoint exists to
	// report: the upstream's own `prompt_tokens` is the ONLY authoritative
	// measurement we ever get, and the gap between it and our chars/4 estimate is
	// where the image tokens live. Fetching 'serialization' here silently pinned
	// `reportedPromptTokens` to null and blanked that whole row of the panel.
	//
	// The heavy columns (content_html, reasoning_text) are dead weight here, but
	// this is a read-only probe on an explicit user action, not the hot path.
	const branch = walkActiveBranch(params.id, { columns: 'all' });

	const toolCtx = await buildChatToolContext({
		userId,
		disabledFeatures,
		supportsTools,
		baseSystemPrompt,
		branch,
		trustedMcpTools: prefs?.trustedMcpTools ?? [],
		timeZone: prefs?.timezone ?? null,
	});

	// Dedupe exactly as the send path does at assignment, or a tool that appears
	// in both the base list and the cross-turn activation seed gets double-billed.
	const toolDefs = toolCtx.toolDefs.length > 0 ? dedupeToolDefs(toolCtx.toolDefs) : [];

	// Mirrors `requireInlineable`'s validity rules: a row that's missing,
	// hard-deleted, or not an image/video degrades to an `[Image deleted]` note
	// upstream and so costs nothing here.
	//
	// Prices the DOWNSCALED VARIANT where one exists, because that's what
	// `mediaIdToDataUrl` actually inlines — quoting the original would overstate a
	// photo tenfold. An image that hasn't been sent yet has no variant cached, and
	// we deliberately don't generate one here (a read-only probe shouldn't sit
	// re-encoding a thread's worth of images), so it prices as the original until
	// the next send. Erring high on a not-yet-sent image is the safe direction.
	const mediaSize = async (mediaId: string): Promise<MediaSize | null> => {
		const row = getMediaForUser(mediaId, userId);
		if (!row || row.hardDeletedAt !== null) return null;
		if (row.kind !== 'image' && row.kind !== 'video') return null;
		if (row.kind === 'image') {
			const variant = await cachedVisionVariantSize(row.storagePath);
			if (variant !== null) return { byteSize: variant, contentType: 'image/jpeg' };
		}
		return { byteSize: row.byteSize, contentType: row.contentType };
	};

	const breakdown = await buildContextBreakdown({
		branch,
		personaParts,
		customSystemPrompt,
		environmentBlock: toolCtx.environmentBlock,
		skillsCatalog: toolCtx.skillsCatalog,
		toolSearchHint: toolCtx.toolSearchHint,
		toolDefs,
		mediaSize,
		contextWindow: modelEntry?.contextWindow ?? null,
	});

	return json(breakdown);
};
