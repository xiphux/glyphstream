/**
 * Per-request chat tool assembly, shared by the two handlers that build an
 * upstream chat request — the message send (`/messages`) and the tool-approval
 * resume (`/tool-approval`). Both must wire up the SAME tool surface and system
 * prompt: agent-skills catalog + activation tools, the deferred-tool
 * `search_tools` advertisement + Tier-1 hint, the caller's per-user MCP tools,
 * and the cross-turn activation seed — plus an identical MCP approval gate.
 *
 * Centralizing the assembly here is the anti-drift measure CLAUDE.md calls out:
 * "appended per request by the message / tool-approval handlers" is two code
 * paths that must not diverge, or a per-user tool appears in one and vanishes in
 * the other (e.g. mid-turn vs. after an approval pause). This builds on the
 * narrower `tool-search-context.ts` / `skills-context.ts` helpers — it owns the
 * orchestration that calls them in the right order with the right gating.
 */
import type { ChatMessage, FeatureCategory, McpUnavailableServer } from '$lib/types/api';
import type { OpenAIToolDefinition } from '../tools/types';
import type { ChatCompletionRequest } from '../endpoints/client';
import { openaiToolDefinitions, resolveActivatedToolDefs } from '../tools';
import { getActiveCanvas } from '../db/queries/artifacts';
import { buildUserMcpToolDefinitions } from '../mcp/tool-bridge';
import { getUserServerStates } from '../mcp/registry';
import { awaitMcpReady } from '../mcp/bootstrap';
import { composeEnvironmentBlock } from './environment-context';
import { appendSkillsCatalog, buildSkillsRequestContext } from './skills-context';
import {
	appendToolSearchHint,
	buildToolSearchRequestContext,
	collectActivatedToolNames,
	dedupeToolDefs,
} from './tool-search-context';

/**
 * Hot-path budget for connecting a per-user MCP server during request
 * assembly. A server that doesn't finish its handshake within this window is
 * left to connect in the background (its tools appear next turn) rather than
 * holding up the send. Short on purpose — a healthy HTTP MCP handshake is well
 * under this; anything slower shouldn't be allowed to block the chat.
 */
const MCP_HOTPATH_CONNECT_BUDGET_MS = 2500;

export interface ChatToolContextInput {
	userId: string;
	disabledFeatures: readonly FeatureCategory[];
	/**
	 * Whether the resolved model/endpoint supports tools (and isn't a fan-out
	 * branch). When false, no tools are advertised, neither the skills catalog nor
	 * the deferred-tool hint is injected, and MCP discovery isn't awaited. The
	 * environment preamble (today's date) is NOT gated on this — a model that can't
	 * call tools still needs to know what day it is, and in fact needs it more,
	 * since it can't reach for get_current_time.
	 */
	supportsTools: boolean;
	/**
	 * System prompt before skills/tool-search injection — `meta.systemPrompt` or
	 * the composed persona prompt.
	 */
	baseSystemPrompt: string | null;
	/**
	 * The active branch AFTER any synthetic skill-activation exchange, used to
	 * seed cross-turn deferred-tool activations.
	 */
	branch: ChatMessage[];
	/** The user's trusted MCP tool names (`prefs.trustedMcpTools`). */
	trustedMcpTools: readonly string[];
	/** The user's IANA timezone (`prefs.timezone`), so the date the model is given
	 *  is the user's today, not the server's. Null falls back to the server's zone. */
	timeZone: string | null;
}

export interface ChatToolContext {
	/** System prompt with the environment preamble, skills catalog, and
	 *  deferred-tool hint folded in. */
	systemPrompt: string | null;
	/** The blocks `systemPrompt` folded in on top of `baseSystemPrompt`, kept
	 *  separately so the context breakdown can price them. The catalog and hint are
	 *  null when the model doesn't support tools (nothing was appended); the
	 *  environment preamble is unconditional. */
	environmentBlock: string;
	skillsCatalog: string | null;
	toolSearchHint: string | null;
	/**
	 * Base upstream tool list: built-ins ∪ skills ∪ per-user MCP ∪ `search_tools`
	 * ∪ the cross-turn activation seed, in that order. NOT deduped — callers
	 * dedupe at assignment (and again when appending within-turn activations),
	 * preserving each handler's existing dedupe semantics.
	 */
	toolDefs: OpenAIToolDefinition[];
	/** Approval gate: MCP tools not on the user's trust list halt for approval. */
	needsApproval: (toolName: string) => boolean;
	/** Per-user MCP servers enabled for this conversation but currently down
	 *  (circuit-broken `failed` state). Surfaced to the client as an inline
	 *  "unavailable" notice. Empty when every enabled server is usable. */
	unavailableMcpServers: McpUnavailableServer[];
}

/**
 * Resolve the system prompt + tool list + approval gate for an upstream chat
 * request. The per-user MCP server state is resolved ONCE (each resolution
 * re-decrypts every per-user credential) and threaded through both the
 * deferred-catalog hint and the per-user tool-def build.
 */
export async function buildChatToolContext(input: ChatToolContextInput): Promise<ChatToolContext> {
	const { userId, disabledFeatures, supportsTools, baseSystemPrompt, branch } = input;

	// The environment preamble (currently: today's date) leads the prompt, and is
	// NOT gated on anything — a conversation with no persona, no memories, and no
	// tools still needs to know what day it is, and a custom-model conversation
	// with its own snapshotted prompt needs it just as much. Without it the model
	// silently dates the world to its training cutoff.
	const environmentBlock = composeEnvironmentBlock(new Date(), input.timeZone);
	let systemPrompt: string | null = [environmentBlock, baseSystemPrompt]
		.filter(Boolean)
		.join('\n\n');

	// Agent skills (Tier-1 catalog + activation tools). Folded into the prompt so
	// both the initial serialize and the per-iteration rebuild carry it.
	const skillsCtx = supportsTools
		? buildSkillsRequestContext(userId, disabledFeatures)
		: { catalog: null, toolDefs: [] as OpenAIToolDefinition[] };
	systemPrompt = appendSkillsCatalog(systemPrompt, skillsCtx.catalog);

	// Block until MCP discovery finishes before we read the tool surface — a
	// partially-populated surface would make the model refuse a tool later in the
	// turn (flaky behavior). Resolved promise after the first call.
	if (supportsTools) await awaitMcpReady();

	// Resolve the caller's per-user MCP server state ONCE, then thread it through
	// both consumers below. On the send path we connect ONLY the servers enabled
	// for this conversation (disabled `mcp:<id>` servers are skipped — no point
	// handshaking tools we'd filter out anyway), circuit-break servers already
	// `failed` (don't re-eat their connect timeout every message), and bound each
	// connect so one slow server can't stall the turn.
	const userServerStates = supportsTools
		? await getUserServerStates(userId, {
				excludeCategories: disabledFeatures,
				skipFailed: true,
				connectBudgetMs: MCP_HOTPATH_CONNECT_BUDGET_MS,
			})
		: [];

	// Deferred tool loading: advertise `search_tools` + inject the Tier-1 hint
	// when this user/conversation has deferred tools.
	const toolSearchCtx = supportsTools
		? await buildToolSearchRequestContext(userId, disabledFeatures, userServerStates)
		: { def: null, hint: null };
	systemPrompt = appendToolSearchHint(systemPrompt, toolSearchCtx.hint);

	const toolDefs: OpenAIToolDefinition[] = [];
	if (supportsTools) {
		toolDefs.push(...openaiToolDefinitions({ excludeCategories: disabledFeatures }));
		toolDefs.push(...skillsCtx.toolDefs);
		// Per-user MCP servers (auth='per_user') can't ride the static registry —
		// append the caller's connected per-user tools. (This also registers per-user
		// deferred tools so the seed below can resolve them.)
		toolDefs.push(
			...(await buildUserMcpToolDefinitions(userId, {
				excludeCategories: disabledFeatures,
				states: userServerStates,
			})),
		);
		// search_tools (only when deferred tools exist for this user/conversation).
		if (toolSearchCtx.def) toolDefs.push(toolSearchCtx.def);
		// Conversation-persistent loading: re-include the full definitions of any
		// deferred tools the model searched up on earlier turns of this branch, so it
		// needn't re-search. Within-turn activations are appended per-iteration by the
		// caller's rebuildRequestBody closure instead.
		toolDefs.push(
			...resolveActivatedToolDefs(collectActivatedToolNames(branch), {
				excludeCategories: disabledFeatures,
			}),
		);
	}

	// Built-in tools and user-trusted MCP tools execute inline; untrusted MCP
	// tools halt the turn with an inline approval prompt.
	const trustedSet = new Set(input.trustedMcpTools);
	const needsApproval = (toolName: string) =>
		toolName.startsWith('mcp__') && !trustedSet.has(toolName);

	// Per-user MCP servers ENABLED for this conversation but currently `failed`
	// — surfaced so a circuit-broken server doesn't silently drop its tools with
	// no signal. Servers disabled for this chat are intentionally omitted (the
	// user turned them off); so are servers still (re)connecting — only a
	// settled failure warns, to avoid a flash of "down" on first connect.
	const unavailableMcpServers = userServerStates
		.filter(
			(s) =>
				s.auth === 'per_user' &&
				s.configured &&
				s.state === 'failed' &&
				!disabledFeatures.includes(`mcp:${s.id}`),
		)
		.map((s) => ({ id: s.id, displayName: s.displayName, error: s.error }));

	return {
		systemPrompt,
		environmentBlock,
		skillsCatalog: skillsCtx.catalog,
		toolSearchHint: toolSearchCtx.hint,
		toolDefs,
		needsApproval,
		unavailableMcpServers,
	};
}

export interface CanvasAugmentInput {
	conversationId: string;
	userId: string;
	disabledFeatures: readonly FeatureCategory[];
	supportsTools: boolean;
}

/**
 * Fold the conversation's open canvas into an upstream request, if any: arm
 * `update_canvas` (never statically advertised) and append the document's
 * current content as ONE `role:'system'` block at the very END of `messages`.
 *
 * This is THE canvas prefix-stability mechanism (CLAUDE.md "the payload is
 * rent"): the mutating document sits only at the tail, so it extends the suffix
 * and never reshuffles the cached prefix, and it's re-read from the DB on every
 * call so within a turn the model always sees the latest state (create_canvas
 * then update_canvas). Called by BOTH the message-send and tool-approval
 * handlers — on the initial body and inside their per-iteration
 * `rebuildRequestBody` — so the two paths can't drift and mid-turn creation
 * arms the editor from the next iteration on. A no-op when tools are
 * unsupported, the `canvas` category is off, or no canvas exists.
 */
export function augmentRequestForCanvas(
	req: ChatCompletionRequest,
	input: CanvasAugmentInput,
): ChatCompletionRequest {
	if (!input.supportsTools || input.disabledFeatures.includes('canvas')) return req;
	const doc = getActiveCanvas(input.conversationId, input.userId);
	if (!doc) return req;

	const updateDef = resolveActivatedToolDefs(['update_canvas'], {
		excludeCategories: input.disabledFeatures,
	});
	const tools = dedupeToolDefs([...(req.tools ?? []), ...updateDef]);

	const titleAttr = doc.title ? ` title=${JSON.stringify(doc.title)}` : '';
	const tail =
		'The user has an open canvas — a document shown beside the chat that you edit with update_canvas. ' +
		'Below is its current, authoritative content. To change it, call update_canvas (str_replace for targeted ' +
		'edits, rewrite to replace it wholesale) rather than repasting the document into your reply.\n\n' +
		`<canvas_current_state version="${doc.versionNumber}"${titleAttr}>\n${doc.content}\n</canvas_current_state>`;

	return {
		...req,
		messages: [...req.messages, { role: 'system', content: tail }],
		...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
	};
}
