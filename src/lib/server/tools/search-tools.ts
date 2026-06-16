/**
 * `search_tools` — the model's path to deferred (hidden) MCP tools.
 *
 * Servers configured `defer_tools = true` keep their tool schemas out of the
 * per-request `tools[]` array (they'd cost thousands of tokens every turn). This
 * built-in lets the model find them on demand: it writes a short capability
 * query, we rank the deferred catalog (hybrid BM25 + optional embeddings), and
 * return the top matches — which the relay then promotes into `tools[]` so the
 * model can call them. Matches persist for the rest of the conversation (the
 * tool result carries `activatedToolNames`, recovered by the turn-start branch
 * scan), so the model doesn't re-search every turn.
 *
 * Like `activate_skill`, the tool registers `isAvailable:() => false` — it is
 * NEVER advertised by the static registry. The message / tool-approval handlers
 * append its definition per request (via `buildToolSearchRequestContext`) only
 * when the user/conversation actually has deferred tools to find.
 */

import { register } from './registry';
import { deferredToolCatalog } from './registry';
import type {
	DeferredToolEntry,
	OpenAIToolDefinition,
	Tool,
	ToolContext,
	ToolExecution,
} from './types';
import { buildUserDeferredToolCatalog } from '../mcp/tool-bridge';
import { searchToolCatalog } from '../retrieval/tool-search';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import type { RelevanceConfig } from '../retrieval/embed-rank';

/** How many matches a single search returns + activates. Bounded so an
 *  over-broad query can't reload the whole catalog. */
export const SEARCH_TOOLS_TOP_K = 5;

/**
 * Cap on how long the SEMANTIC leg may take before tool search gives up and
 * returns BM25-only results. The dense leg is best-effort here: the catalog is
 * tiny (a warm embed is sub-second) and BM25 over namespaced tool names is
 * already a strong baseline, so a slow/cold/overloaded embeddings endpoint
 * shouldn't make the user wait. Much shorter than the 30s `[embeddings]` default
 * (right for fetch_url's large page batches, wrong for an interactive lookup).
 * Applied as a min with the configured timeout, so lowering `timeout_seconds`
 * also lowers this.
 */
export const TOOL_SEARCH_EMBED_TIMEOUT_SECONDS = 5;

/**
 * The embeddings RelevanceConfig for tool search — the shared resolver's, with
 * the timeout capped (see {@link TOOL_SEARCH_EMBED_TIMEOUT_SECONDS}). Undefined
 * when embeddings aren't configured (search runs BM25-only). Exported for tests.
 */
export function toolSearchEmbeddingConfig(): RelevanceConfig | undefined {
	const cfg = resolveRelevanceConfig();
	if (!cfg) return undefined;
	return {
		...cfg,
		timeoutSeconds: Math.min(cfg.timeoutSeconds, TOOL_SEARCH_EMBED_TIMEOUT_SECONDS),
	};
}

const SEARCH_TOOLS_DESCRIPTION =
	'Load additional tools that are not currently loaded. To save context, some tools are listed by name (see the available-tools list) but their schemas are hidden until needed. Write a SHORT query describing the capability you need — lead with the ACTION verb, not the user\'s whole request (e.g. "list tasks due today", "find recent emails", "create a github issue", "send a slack message"). The exact tool name from the available-tools list also works as a query. Returns up to ' +
	String(SEARCH_TOOLS_TOP_K) +
	" matching tools, which then become callable (immediately and for the rest of this conversation). If the results don't match what you need, call search_tools again with different or more specific words — do NOT tell the user a capability is unavailable until a search has failed to find it.";

/** The advertised definition — static (the `query` is free text, no enum). */
export function searchToolsDefinition(): OpenAIToolDefinition {
	return {
		type: 'function',
		function: {
			name: 'search_tools',
			description: SEARCH_TOOLS_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'A short phrase describing the tool capability you need, e.g. "create calendar event".',
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
	};
}

function parseQueryArg(args: unknown): { query: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` field.' };
	}
	const q = (args as { query?: unknown }).query;
	if (typeof q !== 'string' || q.trim().length === 0) {
		return { error: 'Missing or empty `query` argument.' };
	}
	return { query: q.trim() };
}

function renderMatches(matches: DeferredToolEntry[], query: string, catalogSize: number): string {
	const lines = matches.map((m) => {
		// Keep the search RESULT cheap: one trimmed line of description per tool.
		const desc = m.description.replace(/\s+/g, ' ').trim();
		const short = desc.length > 160 ? `${desc.slice(0, 159)}…` : desc;
		return `- ${m.name} — ${short}`;
	});
	// Report the truncation honestly: the model must know these are the TOP few
	// of a larger catalog, ranked — not the complete set — so a weak first query
	// prompts a refined re-search instead of a premature "capability unavailable".
	const header =
		`Top ${matches.length} of ${catalogSize} tools, ranked by relevance to "${query}". ` +
		'These are now callable.';
	const footer =
		matches.length < catalogSize
			? '\nIf none of these does what you need, call search_tools again with different or more specific words.'
			: '';
	return `${header}\n${lines.join('\n')}${footer}`;
}

export const searchToolsTool: Tool = {
	definition: searchToolsDefinition(),
	metadata: { displayLabel: 'Search tools', icon: 'search' },
	// Advertised per-request by buildToolSearchRequestContext (only when deferred
	// tools exist), never by the static registry — same trick as activate_skill.
	isAvailable: () => false,
	async execute(args, ctx: ToolContext): Promise<ToolExecution> {
		const parsed = parseQueryArg(args);
		if ('error' in parsed)
			return { content: JSON.stringify({ error: parsed.error }), isError: true };

		// Build the searchable catalog, re-applying the conversation's category
		// opt-outs at execute time (defends the advertise→call race, same as
		// skills' dual gate). Global deferred tools + this user's per-user ones.
		// This resolves per-user server state fresh (no request-setup snapshot is
		// threaded down to tool execution) — deliberate: a turn can run for many
		// seconds and iterations before/between search_tools calls, during which a
		// per-user server may connect, so the freshest catalog is the correct one.
		const catalog: DeferredToolEntry[] = [
			...deferredToolCatalog({ excludeCategories: ctx.disabledFeatures }),
			...(await buildUserDeferredToolCatalog(ctx.userId, {
				excludeCategories: ctx.disabledFeatures,
			})),
		];
		if (catalog.length === 0) {
			return { content: 'No additional tools are available to load.', activatedToolNames: [] };
		}

		const ranked = await searchToolCatalog(
			parsed.query,
			catalog,
			toolSearchEmbeddingConfig(),
			ctx.signal,
		);
		const top = ranked.slice(0, SEARCH_TOOLS_TOP_K);
		if (top.length === 0) {
			return {
				content: `No tools matched "${parsed.query}". Try different keywords, or proceed without these tools.`,
				activatedToolNames: [],
			};
		}
		return {
			content: renderMatches(top, parsed.query, catalog.length),
			activatedToolNames: top.map((t) => t.name),
		};
	},
};

register(searchToolsTool);
