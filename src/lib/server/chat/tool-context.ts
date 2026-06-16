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
import type { ChatMessage, FeatureCategory } from '$lib/types/api';
import type { OpenAIToolDefinition } from '../tools/types';
import { openaiToolDefinitions, resolveActivatedToolDefs } from '../tools';
import { buildUserMcpToolDefinitions } from '../mcp/tool-bridge';
import { getUserServerStates } from '../mcp/registry';
import { awaitMcpReady } from '../mcp/bootstrap';
import { appendSkillsCatalog, buildSkillsRequestContext } from './skills-context';
import {
	appendToolSearchHint,
	buildToolSearchRequestContext,
	collectActivatedToolNames,
} from './tool-search-context';

export interface ChatToolContextInput {
	userId: string;
	disabledFeatures: readonly FeatureCategory[];
	/**
	 * Whether the resolved model/endpoint supports tools (and isn't a fan-out
	 * branch). When false, no tools are advertised and neither the skills catalog
	 * nor the deferred-tool hint is injected — the system prompt passes through
	 * unchanged and MCP discovery isn't awaited.
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
}

export interface ChatToolContext {
	/** System prompt with the skills catalog + deferred-tool hint folded in. */
	systemPrompt: string | null;
	/**
	 * Base upstream tool list: built-ins ∪ skills ∪ per-user MCP ∪ `search_tools`
	 * ∪ the cross-turn activation seed, in that order. NOT deduped — callers
	 * dedupe at assignment (and again when appending within-turn activations),
	 * preserving each handler's existing dedupe semantics.
	 */
	toolDefs: OpenAIToolDefinition[];
	/** Approval gate: MCP tools not on the user's trust list halt for approval. */
	needsApproval: (toolName: string) => boolean;
}

/**
 * Resolve the system prompt + tool list + approval gate for an upstream chat
 * request. The per-user MCP server state is resolved ONCE (each resolution
 * re-decrypts every per-user credential) and threaded through both the
 * deferred-catalog hint and the per-user tool-def build.
 */
export async function buildChatToolContext(input: ChatToolContextInput): Promise<ChatToolContext> {
	const { userId, disabledFeatures, supportsTools, baseSystemPrompt, branch } = input;

	// Agent skills (Tier-1 catalog + activation tools). Folded into the prompt so
	// both the initial serialize and the per-iteration rebuild carry it.
	const skillsCtx = supportsTools
		? buildSkillsRequestContext(userId, disabledFeatures)
		: { catalog: null, toolDefs: [] as OpenAIToolDefinition[] };
	let systemPrompt = appendSkillsCatalog(baseSystemPrompt, skillsCtx.catalog);

	// Block until MCP discovery finishes before we read the tool surface — a
	// partially-populated surface would make the model refuse a tool later in the
	// turn (flaky behavior). Resolved promise after the first call.
	if (supportsTools) await awaitMcpReady();

	// Resolve the caller's per-user MCP server state ONCE, then thread it through
	// both consumers below.
	const userServerStates = supportsTools ? await getUserServerStates(userId) : [];

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

	return { systemPrompt, toolDefs, needsApproval };
}
