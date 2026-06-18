/**
 * `web_search` — query a SearxNG instance and return a terse list of
 * {title, url, snippet} results, plus any instant-answer / infobox /
 * spelling-correction blocks the engine surfaced. The model decides when
 * to call it, mirroring how Cursor / Claude / ChatGPT surface search
 * rather than forcing the user to toggle it on per query.
 *
 * Hidden from the model via `isAvailable()` when `[search]` is absent
 * from config.toml — deployments without a SearxNG instance just don't
 * advertise it. The paired `fetch_url` tool is always available, so
 * users can still feed in URLs by hand even without search.
 *
 * Wire shape upstream: GET {url}/search?q=...&format=json&safesearch=1,
 * with optional time_range / categories / language passed through from
 * the tool args. Requires the SearxNG instance to have JSON output
 * enabled in its settings.yml: `search.formats: [html, json]`.
 *
 * Results are de-duplicated by a normalized URL key (mirrors / syndicated
 * copies / tracking-param variants collapse to one) before the list is
 * trimmed to `max_results`, so the model sees that many *distinct* hits.
 */

import { loadSearchConfig, type LoadedSearchConfig } from '../endpoints/config';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { composeSignals } from '../util/abort';

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;

// SearxNG's supported `time_range` values (freshness filter).
const TIME_RANGES = ['day', 'week', 'month', 'year'] as const;
type TimeRange = (typeof TIME_RANGES)[number];

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
				'Search the web for current information you do not already know — current events, recent docs, anything past your training cutoff. Returns {query, results} where results is a list of {title, url, snippet}; may also include `answers` (instant-answer boxes), `infoboxes` (encyclopedia-style summaries), and `corrections` (spelling fixes) when the engine surfaces them — check those before fetching, they often answer simple questions directly. Use fetch_url on a result URL when you need to read the full page.',
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
					time_range: {
						type: 'string',
						enum: [...TIME_RANGES],
						description:
							'Optional freshness filter — restrict results to the past day/week/month/year. Use for time-sensitive queries (recent news, latest releases).',
					},
					categories: {
						type: 'string',
						description:
							'Optional SearxNG category scope, comma-separated (e.g. "news", "science", "news,it"). Omit for a general web search.',
					},
					language: {
						type: 'string',
						description:
							'Optional language/locale code to bias results (e.g. "en", "en-US", "de").',
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
		const { query, maxResults, timeRange, categories, language } = parsed;

		const url = new URL(cfg.url + '/search');
		url.searchParams.set('q', query);
		url.searchParams.set('format', 'json');
		url.searchParams.set('safesearch', '1');
		if (timeRange) url.searchParams.set('time_range', timeRange);
		if (categories) url.searchParams.set('categories', categories);
		if (language) url.searchParams.set('language', language);

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
			const obj = (body ?? {}) as Record<string, unknown>;

			const raw = Array.isArray(obj.results) ? (obj.results as Array<Record<string, unknown>>) : [];
			// Map every row, then collapse duplicates, THEN trim — so `max_results`
			// counts distinct hits rather than being padded by mirrors.
			const mapped = raw.map((r) => ({
				title: typeof r.title === 'string' ? r.title : '',
				url: typeof r.url === 'string' ? r.url : '',
				snippet: typeof r.content === 'string' ? r.content : '',
			}));
			const results = dedupeResults(mapped).slice(0, maxResults);

			const answers = normalizeAnswers(obj.answers);
			const infoboxes = normalizeInfoboxes(obj.infoboxes);
			const corrections = normalizeCorrections(obj.corrections);

			const payload: Record<string, unknown> = { query, results };
			if (answers.length > 0) payload.answers = answers;
			if (infoboxes.length > 0) payload.infoboxes = infoboxes;
			if (corrections.length > 0) payload.corrections = corrections;

			return { content: JSON.stringify(payload) };
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	},
};

interface ParsedArgs {
	query: string;
	maxResults: number;
	timeRange?: TimeRange;
	categories?: string;
	language?: string;
}

function parseArgs(args: unknown): ParsedArgs | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` field.' };
	}
	const a = args as {
		query?: unknown;
		max_results?: unknown;
		time_range?: unknown;
		categories?: unknown;
		language?: unknown;
	};
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

	let timeRange: TimeRange | undefined;
	if (a.time_range !== undefined && a.time_range !== '') {
		if (typeof a.time_range !== 'string' || !TIME_RANGES.includes(a.time_range as TimeRange)) {
			return { error: `\`time_range\` must be one of: ${TIME_RANGES.join(', ')}.` };
		}
		timeRange = a.time_range as TimeRange;
	}

	const categories = optionalStringArg(a.categories);
	if ('error' in categories) return { error: '`categories` must be a string.' };
	const language = optionalStringArg(a.language);
	if ('error' in language) return { error: '`language` must be a string.' };

	return {
		query: a.query,
		maxResults,
		timeRange,
		categories: categories.value,
		language: language.value,
	};
}

/** A non-empty trimmed string, or undefined; an error object on a non-string. */
function optionalStringArg(v: unknown): { value: string | undefined } | { error: true } {
	if (v === undefined) return { value: undefined };
	if (typeof v !== 'string') return { error: true };
	const trimmed = v.trim();
	return { value: trimmed.length > 0 ? trimmed : undefined };
}

interface MappedResult {
	title: string;
	url: string;
	snippet: string;
}

// Query params that identify a campaign/click, not a distinct page — strip them
// (plus any `utm_*`) when building the dedupe key so mirrors with tracking tails
// collapse. Deliberately conservative: real content params (e.g. `?id=`, `?p=`)
// are kept, so two genuinely different pages are never merged.
const TRACKING_PARAMS = new Set([
	'fbclid',
	'gclid',
	'gbraid',
	'wbraid',
	'msclkid',
	'mc_eid',
	'mc_cid',
	'igshid',
	'ref',
	'ref_src',
	'_hsenc',
	'_hsmi',
]);

/**
 * Normalized identity for a result URL: lowercased host without a leading
 * `www.`, path without a trailing slash, fragment dropped, and tracking params
 * removed (remaining params sorted for stability). Unparseable URLs fall back to
 * their raw string so they still dedupe by exact match.
 */
function normalizeUrlKey(rawUrl: string): string {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	const host = u.hostname.toLowerCase().replace(/^www\./, '');
	const path = u.pathname.replace(/\/+$/, '') || '/';
	const params = [...u.searchParams.entries()]
		.filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query = params.length > 0 ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
	return `${host}${path}${query}`;
}

/**
 * Drop near-duplicate results, keeping the first (highest-ranked) of each
 * normalized-URL group. Rows without a URL are always kept — an empty URL is not
 * an identity, so they must not collapse into each other.
 */
function dedupeResults(results: MappedResult[]): MappedResult[] {
	const seen = new Set<string>();
	const out: MappedResult[] = [];
	for (const r of results) {
		if (!r.url) {
			out.push(r);
			continue;
		}
		const key = normalizeUrlKey(r.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

interface AnswerEntry {
	answer: string;
	url?: string;
}

/**
 * SearxNG's `answers` is either an array of strings (older) or of
 * `{answer, url}` objects (newer). Normalize both to `{answer, url?}`,
 * dropping anything without answer text.
 */
function normalizeAnswers(raw: unknown): AnswerEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: AnswerEntry[] = [];
	for (const a of raw) {
		if (typeof a === 'string') {
			const s = a.trim();
			if (s) out.push({ answer: s });
		} else if (a && typeof a === 'object') {
			const obj = a as { answer?: unknown; url?: unknown };
			const answer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
			if (!answer) continue;
			out.push(typeof obj.url === 'string' && obj.url ? { answer, url: obj.url } : { answer });
		}
	}
	return out;
}

interface InfoboxEntry {
	title: string;
	content: string;
	url?: string;
}

/**
 * Trim SearxNG `infoboxes` down to {title, content, url}; the verbose
 * attributes/urls arrays are dropped to keep the payload terse.
 */
function normalizeInfoboxes(raw: unknown): InfoboxEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: InfoboxEntry[] = [];
	for (const ib of raw) {
		if (!ib || typeof ib !== 'object') continue;
		const obj = ib as { infobox?: unknown; content?: unknown; id?: unknown };
		const title = typeof obj.infobox === 'string' ? obj.infobox.trim() : '';
		const content = typeof obj.content === 'string' ? obj.content.trim() : '';
		if (!title && !content) continue;
		out.push(
			typeof obj.id === 'string' && obj.id ? { title, content, url: obj.id } : { title, content },
		);
	}
	return out;
}

/**
 * SearxNG `corrections` — spelling/"did you mean" suggestions as plain strings.
 *
 * Unlike `answers` (whose `{answer, url}` object form is documented and seen
 * live), no object-form correction shape is documented, so non-strings are
 * intentionally dropped rather than parsed by guessing which field holds the
 * text. Revisit if a real instance is found to emit object-form corrections.
 */
function normalizeCorrections(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
		.map((c) => c.trim());
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(webSearchTool);
