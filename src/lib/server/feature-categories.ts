/**
 * Assemble the per-conversation feature-category list that the composer
 * UI consumes. Built-in categories ('web', 'personalization') come from
 * `$lib/types/api`; MCP-server categories (`mcp:<server-id>`) come from
 * the live MCP registry.
 *
 * Must run server-side — the MCP registry isn't exposed to the browser
 * bundle. The (app) layout loader awaits MCP readiness before calling
 * this and ships the result to every (app) page.
 */

import {
	BUILTIN_FEATURE_CATEGORIES,
	FEATURE_CATEGORY_LABELS,
	type FeatureCategoryEntry,
} from '$lib/types/api';
import { listMcpServerStates } from './mcp/registry';

export type { FeatureCategoryEntry };

export function getAllFeatureCategoryLabels(): FeatureCategoryEntry[] {
	const builtin: FeatureCategoryEntry[] = BUILTIN_FEATURE_CATEGORIES.map((id) => ({
		id,
		label: FEATURE_CATEGORY_LABELS[id].label,
		description: FEATURE_CATEGORY_LABELS[id].description,
		source: 'builtin',
	}));
	const mcp: FeatureCategoryEntry[] = listMcpServerStates()
		.filter((s) => s.state !== 'failed')
		.map((s) => {
			const toolCount = s.tools.length;
			const noun = toolCount === 1 ? 'tool' : 'tools';
			return {
				id: `mcp:${s.id}`,
				label: s.displayName,
				description: `Tools from the "${s.displayName}" MCP server (${toolCount} ${noun}).`,
				source: 'mcp',
			};
		});
	return [...builtin, ...mcp];
}

/**
 * Set of category ids that are currently registered (built-in or live
 * MCP). Used by the conversation-create seed and the custom-models
 * validator to silently drop / reject categories that point at MCP
 * servers no longer present in config.toml.
 */
export function getRegisteredCategoryIds(): Set<string> {
	return new Set(getAllFeatureCategoryLabels().map((c) => c.id));
}
