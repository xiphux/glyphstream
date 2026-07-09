/**
 * "Private chat" request-time consumption seal.
 *
 * A private conversation (`conversations.private`) is airgapped: no data flows in
 * from the user's cross-conversation stores, and nothing flows out to a secondary
 * model — only the chat's own (the one exception is auto-titling, and only when the
 * operator has explicitly marked the task model trusted with `[task_model]
 * private = true`; see title-task-runner.ts). The content-OUT half (never
 * summarized / never returned by the search tool) is enforced in the DB queries;
 * this is the request-time consumption half — an *effective* disabled-feature set
 * derived from the conversation's base opt-outs.
 *
 * We derive rather than persist (the `private` flag stays a separate axis from
 * `disabled_features`) so the seal is unbreakable: the user can't re-enable
 * personalization on a private chat via the features menu, and a newly-configured
 * MCP server is sealed automatically without a data migration.
 *
 * The one derived set drives every avenue the handlers already gate on
 * `disabledFeatures`:
 *   - `personalization` — persona/memory/overview injection + the memory tools +
 *     `search_conversations` (one category seals them all).
 *   - `web` — web_search / fetch_url (and, transitively, run_python's net egress).
 *   - `image_prompt_enhancement` / `video_prompt_enhancement` — the optional LLM
 *     prompt rewrite ships content to a secondary model; sealed so a private chat
 *     talks only to its own model.
 *   - every `mcp:<id>` — all MCP servers (data can leave the box through them).
 *
 * Deliberately LEFT ENABLED: `code_interpreter` (run_python runs in a sandboxed
 * server-side worker; its only network egress is already sealed by the `web`
 * disable, and any files it emits are persisted as the user's own conversation
 * media — never indexed for search, since promptExcerpt is null — not sent
 * anywhere) and `skills` (static context pulled IN, nothing sent out).
 */
import { listServerCatalog } from '../mcp/registry';
import { PRIVATE_SEALED_BUILTIN_CATEGORIES } from '$lib/types/api';
import type { FeatureCategory } from '$lib/types/api';

/**
 * The effective disabled-feature set for a private conversation: its base opt-outs
 * unioned with the always-sealed builtins and every configured MCP server's
 * `mcp:<id>` category.
 *
 * Sync + race-free: `listServerCatalog()` reads the server catalog populated by
 * `bootstrapMcp()`'s synchronous prefix at hooks module load, i.e. before any
 * request is served (the connection attempts are async, the catalog population is
 * not). The MCP catalog is user-independent — sealing a server the user has no
 * credential for is a harmless no-op.
 */
export function sealPrivateFeatures(base: readonly FeatureCategory[]): FeatureCategory[] {
	const sealed = new Set<FeatureCategory>(base);
	for (const c of PRIVATE_SEALED_BUILTIN_CATEGORIES) sealed.add(c);
	for (const s of listServerCatalog()) sealed.add(`mcp:${s.id}`);
	return [...sealed];
}

/**
 * The effective feature opt-outs for a turn, from the conversation meta: a private
 * chat's base opt-outs sealed up, otherwise its opt-outs verbatim. The single
 * place the two chat handlers (message-send + tool-approval) derive this, so the
 * seal can't drift between them.
 */
export function resolveDisabledFeatures(meta: {
	private: boolean;
	disabledFeatures: FeatureCategory[];
}): FeatureCategory[] {
	return meta.private ? sealPrivateFeatures(meta.disabledFeatures) : meta.disabledFeatures;
}
