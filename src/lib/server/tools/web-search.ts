/**
 * `web_search` — query a SearxNG instance and return a terse list of
 * {title, url, snippet} results. The model decides when to call it,
 * mirroring how Cursor / Claude / ChatGPT surface search rather than
 * forcing the user to toggle it on per query.
 *
 * Hidden from the model via `isAvailable()` when `[search]` is absent
 * from config.toml — deployments without a SearxNG instance just don't
 * advertise it. The paired `fetch_url` tool is always available, so
 * users can still feed in URLs by hand even without search.
 *
 * Wire shape upstream: GET {url}/search?q=...&format=json&safesearch=1.
 * Requires the SearxNG instance to have JSON output enabled in its
 * settings.yml: `search.formats: [html, json]`.
 */

import { loadSearchConfig, type LoadedSearchConfig } from '../endpoints/config';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { composeSignals } from '../util/abort';

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;

let configCache: { value: LoadedSearchConfig | null } | undefined;

function getConfig(): LoadedSearchConfig | null {
	if (!configCache) configCache = { value: loadSearchConfig() };
	return configCache.value;
}

/** Test hook: clear the memoized config so the next call re-reads. */
export function _resetConfigCacheForTests(): void {
	configCache = undefined;
}

export const webSearchTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current information you do not already know — current events, recent docs, anything past your training cutoff. Returns a list of {title, url, snippet} results. Use fetch_url on a result URL when you need to read the full page.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Search query, plain natural-language text.',
					},
					max_results: {
						type: 'integer',
						description: `How many results to return (1-${MAX_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
						minimum: 1,
						maximum: MAX_MAX_RESULTS,
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Web search', icon: 'search', category: 'web' },
	isAvailable: () => getConfig() !== null,
	async execute(args, ctx): Promise<ToolExecution> {
		const cfg = getConfig();
		if (!cfg)
			return errorResult('web_search not configured ([search] block missing from config.toml).');

		const parsed = parseArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const { query, maxResults } = parsed;

		const url = new URL(cfg.url + '/search');
		url.searchParams.set('q', query);
		url.searchParams.set('format', 'json');
		url.searchParams.set('safesearch', '1');

		const headers: Record<string, string> = { 'user-agent': 'glyphstream' };
		if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

		const signal = composeSignals(ctx.signal, AbortSignal.timeout(cfg.timeoutSeconds * 1000));

		try {
			const res = await fetch(url, { headers, signal });
			if (!res.ok) {
				return errorResult(`SearxNG returned HTTP ${res.status}.`);
			}
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				return errorResult(
					'SearxNG response was not valid JSON (is `search.formats: [json]` enabled?).',
				);
			}
			const raw = Array.isArray((body as { results?: unknown[] }).results)
				? ((body as { results: unknown[] }).results as Array<Record<string, unknown>>)
				: [];
			const results = raw.slice(0, maxResults).map((r) => ({
				title: typeof r.title === 'string' ? r.title : '',
				url: typeof r.url === 'string' ? r.url : '',
				snippet: typeof r.content === 'string' ? r.content : '',
			}));
			return { content: JSON.stringify({ query, results }) };
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	},
};

interface ParsedArgs {
	query: string;
	maxResults: number;
}

function parseArgs(args: unknown): ParsedArgs | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` field.' };
	}
	const a = args as { query?: unknown; max_results?: unknown };
	if (typeof a.query !== 'string' || a.query.length === 0) {
		return { error: 'Missing or empty `query` argument.' };
	}
	let maxResults = DEFAULT_MAX_RESULTS;
	if (a.max_results !== undefined) {
		if (typeof a.max_results !== 'number' || !Number.isFinite(a.max_results)) {
			return { error: '`max_results` must be an integer.' };
		}
		maxResults = Math.max(1, Math.min(MAX_MAX_RESULTS, Math.floor(a.max_results)));
	}
	return { query: a.query, maxResults };
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(webSearchTool);
