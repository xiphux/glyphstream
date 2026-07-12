import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ConfigError,
	DEFAULT_IMAGE_ENHANCEMENT_MAX_TOKENS,
	DEFAULT_IMAGE_ENHANCEMENT_TEMPERATURE,
	DEFAULT_MAX_TOOL_LOOP_ITERATIONS,
	DEFAULT_MAX_TOOL_RESULT_CHARS,
	MIN_MAX_TOOL_RESULT_CHARS,
	DEFAULT_VISION_MAX_IMAGE_DIM,
	DEFAULT_VISION_IMAGE_QUALITY,
	MIN_VISION_MAX_IMAGE_DIM,
	loadVisionConfig,
	loadMaxToolResultChars,
	loadEmbeddingsConfig,
	loadEndpoints,
	loadImageEnhancementConfig,
	loadMaxToolLoopIterations,
	loadMemoryModelConfig,
	loadNotificationsConfig,
	loadRerankConfig,
	loadSearchConfig,
	loadTaskModel,
	loadTaskModelConfig,
	DEFAULT_MEMORY_MODEL_MAX_TOKENS,
	DEFAULT_MEMORY_MODEL_TEMPERATURE,
	DEFAULT_MEMORY_OVERVIEW_MAX_CHARS,
} from '$lib/server/endpoints/config';

// Stub $env/dynamic/private so we can control api_key_env resolution
// without touching the real process env.
const envStub = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({
	env: new Proxy({} as Record<string, string>, {
		get: (_t, k: string) => envStub.values[k],
	}),
}));

const tmpDirs: string[] = [];
function writeConfig(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'gs-config-'));
	tmpDirs.push(dir);
	const path = join(dir, 'config.toml');
	writeFileSync(path, toml);
	return path;
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	envStub.values = {};
});

describe('loadEndpoints', () => {
	it('parses a minimal valid endpoint', () => {
		const path = writeConfig(`
[[endpoints]]
id = "bridge"
base_url = "http://localhost:8080/v1"
		`);
		const eps = loadEndpoints(path);
		expect(eps).toHaveLength(1);
		expect(eps[0]).toMatchObject({
			id: 'bridge',
			displayName: 'bridge',
			baseUrl: 'http://localhost:8080/v1',
			apiKey: null,
			requestTimeoutSeconds: 120,
			providerQuirk: 'passthrough',
			// Friendly default cap so a large fan-out trickles (not unlimited).
			maxConcurrent: 4,
			// No blanket context window unless the operator states one.
			contextWindow: null,
		});
	});

	it('honors an explicit context_window and validates it', () => {
		expect(
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
context_window = 32768
			`),
			)[0].contextWindow,
		).toBe(32768);

		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
context_window = 0
			`),
			),
		).toThrow(ConfigError);

		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
context_window = 1.5
			`),
			),
		).toThrow(/whole number/);
	});

	it('defaults model_context_windows to an empty table', () => {
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
		`),
		)[0];
		expect(ep.modelContextWindows).toEqual({});
	});

	it('parses per-model context_window overrides keyed by model id', () => {
		// Sub-table form binds to the preceding [[endpoints]] element.
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "llama"
base_url = "http://localhost:8081/v1"
context_window = 8192

[endpoints.model_context_windows]
"Gemma4-26B" = 40960
"GLM-4.7-Flash" = 65536
		`),
		)[0];
		expect(ep.contextWindow).toBe(8192);
		expect(ep.modelContextWindows).toEqual({ 'Gemma4-26B': 40960, 'GLM-4.7-Flash': 65536 });
	});

	it('also accepts the inline-table form', () => {
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "llama"
base_url = "http://localhost:8081/v1"
model_context_windows = { "Gemma4-26B" = 40960 }
		`),
		)[0];
		expect(ep.modelContextWindows).toEqual({ 'Gemma4-26B': 40960 });
	});

	it('rejects a non-positive or non-integer per-model context window', () => {
		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "llama"
base_url = "http://localhost:8081/v1"

[endpoints.model_context_windows]
"Gemma4-26B" = 0
			`),
			),
		).toThrow(/model_context_windows/);

		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "llama"
base_url = "http://localhost:8081/v1"

[endpoints.model_context_windows]
"Gemma4-26B" = 1.5
			`),
			),
		).toThrow(/whole number/);
	});

	it('rejects model_context_windows that is not a table', () => {
		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "llama"
base_url = "http://localhost:8081/v1"
model_context_windows = 40960
		`),
			),
		).toThrow(/must be a table/);
	});

	it('honors an explicit max_concurrent and validates its bounds', () => {
		expect(
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
max_concurrent = 1
			`),
			)[0].maxConcurrent,
		).toBe(1);

		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
max_concurrent = 0
			`),
			),
		).toThrow(ConfigError);

		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "local"
base_url = "http://localhost:8081/v1"
max_concurrent = 2.5
			`),
			),
		).toThrow(/whole number/);
	});

	it('strips trailing slashes from base_url', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x/v1///"
		`);
		expect(loadEndpoints(path)[0].baseUrl).toBe('http://x/v1');
	});

	it('uses display_name when provided', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
display_name = "My Bridge"
		`);
		expect(loadEndpoints(path)[0].displayName).toBe('My Bridge');
	});

	it('resolves api_key_env to the env var value', () => {
		envStub.values.MY_KEY = 'sk-secret-123';
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
api_key_env = "MY_KEY"
		`);
		expect(loadEndpoints(path)[0].apiKey).toBe('sk-secret-123');
	});

	it('throws when api_key_env points at an unset env var', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
api_key_env = "MISSING_KEY"
		`);
		expect(() => loadEndpoints(path)).toThrow(ConfigError);
	});

	it('returns [] for an empty TOML file', () => {
		const path = writeConfig('');
		expect(loadEndpoints(path)).toEqual([]);
	});

	it('treats a missing file as an empty config, not an error', () => {
		// A missing config means "nothing is configured", which is already a legal
		// state here ("Empty config is allowed — no endpoints yet"): a file that omits
		// [[endpoints]] and a file that doesn't exist are the same situation. Throwing
		// mattered once the OPTIONAL loaders started being read from hot paths
		// (serialize-upstream, the media path) — config.toml is gitignored, so CI has
		// none, and the whole unit suite went red on an ENOENT thrown from a module
		// nobody would connect to config.
		expect(loadEndpoints('/nonexistent/path/config.toml')).toEqual([]);
	});

	it('still throws on a config that exists but cannot be read', () => {
		// Only ENOENT is forgiven. A permissions/IO error means a config IS there and
		// is broken — an operator needs to be told, not silently given defaults.
		const path = writeConfig('[[endpoints]]\nid = "e"\nbase_url = "http://e"\n');
		chmodSync(path, 0o000);
		try {
			// Root ignores the mode bits, so only assert when the deny actually applies.
			if (process.getuid?.() !== 0) {
				expect(() => loadEndpoints(path)).toThrow(ConfigError);
			}
		} finally {
			chmodSync(path, 0o600);
		}
	});

	it('throws on invalid TOML syntax', () => {
		const path = writeConfig('this is = = not valid toml');
		expect(() => loadEndpoints(path)).toThrow(ConfigError);
	});

	it('rejects duplicate endpoint ids', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"

[[endpoints]]
id = "x"
base_url = "http://y"
		`);
		expect(() => loadEndpoints(path)).toThrow(/Duplicate endpoint id/);
	});

	it('rejects ids that do not match the slug regex', () => {
		const path = writeConfig(`
[[endpoints]]
id = "Has-Capital"
base_url = "http://x"
		`);
		expect(() => loadEndpoints(path)).toThrow(/lowercase alphanumeric/);
	});

	it('rejects base_url without http(s) scheme', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "ftp://x"
		`);
		expect(() => loadEndpoints(path)).toThrow(/must start with http/);
	});

	it('accepts known provider quirks', () => {
		const path = writeConfig(`
[[endpoints]]
id = "ds"
base_url = "http://x"
provider_quirk = "deepseek-r1"
		`);
		expect(loadEndpoints(path)[0].providerQuirk).toBe('deepseek-r1');
	});

	it('rejects unknown provider quirks', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
provider_quirk = "made-up"
		`);
		expect(() => loadEndpoints(path)).toThrow(/provider_quirk/);
	});

	it('defaults group_by to "endpoint"', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadEndpoints(path)[0].groupBy).toBe('endpoint');
	});

	it('accepts group_by = "owned_by"', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
group_by = "owned_by"
		`);
		expect(loadEndpoints(path)[0].groupBy).toBe('owned_by');
	});

	it('rejects unknown group_by values', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
group_by = "by-model-name"
		`);
		expect(() => loadEndpoints(path)).toThrow(/group_by/);
	});

	it('defaults supports_tools to false', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadEndpoints(path)[0].supportsTools).toBe(false);
	});

	it('parses supports_tools = true', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
supports_tools = true
		`);
		expect(loadEndpoints(path)[0].supportsTools).toBe(true);
	});

	it('rejects non-boolean supports_tools', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
supports_tools = "yes"
		`);
		expect(() => loadEndpoints(path)).toThrow(/supports_tools/);
	});

	it('rejects non-positive request_timeout_seconds', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
request_timeout_seconds = 0
		`);
		expect(() => loadEndpoints(path)).toThrow();
	});
});

describe('loadNotificationsConfig', () => {
	it('returns null when [notifications] is absent', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadNotificationsConfig(path)).toBeNull();
	});

	it('parses a valid [notifications] block with env-resolved private key', () => {
		envStub.values.VAPID_PRIVATE_KEY = 'super-secret-private';
		const path = writeConfig(`
[notifications]
vapid_public = "BPI-public-key"
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "mailto:admin@example.com"
		`);
		expect(loadNotificationsConfig(path)).toEqual({
			vapidPublic: 'BPI-public-key',
			vapidPrivate: 'super-secret-private',
			vapidSubject: 'mailto:admin@example.com',
		});
	});

	it('accepts an https:// subject in place of mailto:', () => {
		envStub.values.VAPID_PRIVATE_KEY = 'p';
		const path = writeConfig(`
[notifications]
vapid_public = "x"
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "https://example.com/contact"
		`);
		expect(loadNotificationsConfig(path)?.vapidSubject).toBe('https://example.com/contact');
	});

	it('throws when the referenced env var is unset', () => {
		const path = writeConfig(`
[notifications]
vapid_public = "x"
vapid_private_env = "MISSING_KEY"
vapid_subject = "mailto:a@b.co"
		`);
		expect(() => loadNotificationsConfig(path)).toThrow(/MISSING_KEY/);
	});

	it('rejects a non-table [notifications] entry', () => {
		const path = writeConfig(`notifications = "nope"`);
		expect(() => loadNotificationsConfig(path)).toThrow(ConfigError);
	});

	it('rejects vapid_subject without mailto: or http(s)://', () => {
		envStub.values.VAPID_PRIVATE_KEY = 'p';
		const path = writeConfig(`
[notifications]
vapid_public = "x"
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "just-some-string"
		`);
		expect(() => loadNotificationsConfig(path)).toThrow(/vapid_subject/);
	});

	it('rejects when vapid_private_env is missing', () => {
		envStub.values.VAPID_PRIVATE_KEY = 'p';
		const path = writeConfig(`
[notifications]
vapid_public = "x"
vapid_subject = "mailto:a@b.co"
		`);
		expect(() => loadNotificationsConfig(path)).toThrow(/vapid_private_env/);
	});

	it('rejects when vapid_public is missing', () => {
		envStub.values.VAPID_PRIVATE_KEY = 'p';
		const path = writeConfig(`
[notifications]
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "mailto:a@b.co"
		`);
		expect(() => loadNotificationsConfig(path)).toThrow(/vapid_public/);
	});
});

describe('loadSearchConfig', () => {
	it('returns null when [search] is absent', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadSearchConfig(path)).toBeNull();
	});

	it('parses a minimal [search] block', () => {
		const path = writeConfig(`
[search]
url = "http://192.168.1.10:8888"
		`);
		expect(loadSearchConfig(path)).toEqual({
			url: 'http://192.168.1.10:8888',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('strips trailing slashes from url', () => {
		const path = writeConfig(`
[search]
url = "http://searx.example.com///"
		`);
		expect(loadSearchConfig(path)?.url).toBe('http://searx.example.com');
	});

	it('resolves api_key_env into apiKey', () => {
		envStub.values.SEARXNG_KEY = 'token-abc';
		const path = writeConfig(`
[search]
url = "https://searx.example.com"
api_key_env = "SEARXNG_KEY"
		`);
		expect(loadSearchConfig(path)?.apiKey).toBe('token-abc');
	});

	it('throws when api_key_env names an unset variable', () => {
		const path = writeConfig(`
[search]
url = "https://searx.example.com"
api_key_env = "MISSING_SEARX_KEY"
		`);
		expect(() => loadSearchConfig(path)).toThrow(/MISSING_SEARX_KEY/);
	});

	it('uses timeout_seconds when supplied', () => {
		const path = writeConfig(`
[search]
url = "https://searx.example.com"
timeout_seconds = 30
		`);
		expect(loadSearchConfig(path)?.timeoutSeconds).toBe(30);
	});

	it('rejects timeout_seconds below 1', () => {
		const path = writeConfig(`
[search]
url = "https://searx.example.com"
timeout_seconds = 0
		`);
		expect(() => loadSearchConfig(path)).toThrow(/timeout_seconds/);
	});

	it('rejects a url without http(s)://', () => {
		const path = writeConfig(`
[search]
url = "searx.example.com"
		`);
		expect(() => loadSearchConfig(path)).toThrow(/url must start with/);
	});

	it('rejects a missing url', () => {
		const path = writeConfig(`
[search]
api_key_env = "X"
		`);
		expect(() => loadSearchConfig(path)).toThrow(/url/);
	});

	it('rejects a non-table [search] entry', () => {
		const path = writeConfig(`search = "nope"`);
		expect(() => loadSearchConfig(path)).toThrow(ConfigError);
	});
});

describe('loadEmbeddingsConfig', () => {
	it('returns null when [embeddings] is absent', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadEmbeddingsConfig(path)).toBeNull();
	});

	it('parses a minimal [embeddings] block with default timeout', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "llama-embed"
model_id = "nomic-embed-text"
		`);
		expect(loadEmbeddingsConfig(path)).toEqual({
			endpointId: 'llama-embed',
			modelId: 'nomic-embed-text',
			timeoutSeconds: 30,
			queryPrefix: '',
			documentPrefix: '',
			maxInputTokens: 512,
			gallerySearchMinSimilarity: 0.5,
		});
	});

	it('parses gallery_search_min_similarity, rejecting out-of-range values', () => {
		const ok = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
gallery_search_min_similarity = 0.7
		`);
		expect(loadEmbeddingsConfig(ok)?.gallerySearchMinSimilarity).toBe(0.7);

		const bad = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
gallery_search_min_similarity = 1.5
		`);
		expect(() => loadEmbeddingsConfig(bad)).toThrow(/gallery_search_min_similarity/);
	});

	it('parses max_input_tokens when supplied', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
max_input_tokens = 8192
		`);
		expect(loadEmbeddingsConfig(path)?.maxInputTokens).toBe(8192);
	});

	it('parses optional query/document prefixes', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
query_prefix = "search_query: "
document_prefix = "search_document: "
		`);
		const cfg = loadEmbeddingsConfig(path);
		expect(cfg?.queryPrefix).toBe('search_query: ');
		expect(cfg?.documentPrefix).toBe('search_document: ');
	});

	it('uses timeout_seconds when supplied', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
timeout_seconds = 5
		`);
		expect(loadEmbeddingsConfig(path)?.timeoutSeconds).toBe(5);
	});

	it('does NOT throw when endpoint_id names an unknown endpoint (resolved at use-time)', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "does-not-exist"
model_id = "m"
		`);
		expect(loadEmbeddingsConfig(path)?.endpointId).toBe('does-not-exist');
	});

	it('rejects a missing endpoint_id', () => {
		const path = writeConfig(`
[embeddings]
model_id = "m"
		`);
		expect(() => loadEmbeddingsConfig(path)).toThrow(/endpoint_id/);
	});

	it('rejects a missing model_id', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "e"
		`);
		expect(() => loadEmbeddingsConfig(path)).toThrow(/model_id/);
	});

	it('rejects timeout_seconds below 1', () => {
		const path = writeConfig(`
[embeddings]
endpoint_id = "e"
model_id = "m"
timeout_seconds = 0
		`);
		expect(() => loadEmbeddingsConfig(path)).toThrow(/timeout_seconds/);
	});

	it('rejects a non-table [embeddings] entry', () => {
		const path = writeConfig(`embeddings = "nope"`);
		expect(() => loadEmbeddingsConfig(path)).toThrow(ConfigError);
	});
});

describe('loadRerankConfig', () => {
	it('returns null when [rerank] is absent', () => {
		const path = writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://x"
		`);
		expect(loadRerankConfig(path)).toBeNull();
	});

	it('parses a minimal [rerank] block with default timeout/top_n and no quirk', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "local-rerank"
model_id = "bge-reranker-v2-m3"
		`);
		expect(loadRerankConfig(path)).toEqual({
			endpointId: 'local-rerank',
			modelId: 'bge-reranker-v2-m3',
			timeoutSeconds: 30,
			topN: 20,
			quirk: undefined,
		});
	});

	it('parses top_n, timeout_seconds, and the tei quirk when supplied', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "e"
model_id = "m"
timeout_seconds = 10
top_n = 12
quirk = "tei"
		`);
		expect(loadRerankConfig(path)).toEqual({
			endpointId: 'e',
			modelId: 'm',
			timeoutSeconds: 10,
			topN: 12,
			quirk: 'tei',
		});
	});

	it('does NOT throw when endpoint_id names an unknown endpoint (resolved at use-time)', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "does-not-exist"
model_id = "m"
		`);
		expect(loadRerankConfig(path)?.endpointId).toBe('does-not-exist');
	});

	it('rejects a missing endpoint_id', () => {
		const path = writeConfig(`
[rerank]
model_id = "m"
		`);
		expect(() => loadRerankConfig(path)).toThrow(/endpoint_id/);
	});

	it('rejects a missing model_id', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "e"
		`);
		expect(() => loadRerankConfig(path)).toThrow(/model_id/);
	});

	it('rejects top_n below 1', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "e"
model_id = "m"
top_n = 0
		`);
		expect(() => loadRerankConfig(path)).toThrow(/top_n/);
	});

	it('rejects an unknown quirk', () => {
		const path = writeConfig(`
[rerank]
endpoint_id = "e"
model_id = "m"
quirk = "cohere"
		`);
		expect(() => loadRerankConfig(path)).toThrow(/quirk/);
	});

	it('rejects a non-table [rerank] entry', () => {
		const path = writeConfig(`rerank = "nope"`);
		expect(() => loadRerankConfig(path)).toThrow(ConfigError);
	});
});

describe('loadMaxToolLoopIterations', () => {
	it('defaults when [tools] is absent', () => {
		const path = writeConfig(`task_model = "e::m"`);
		expect(loadMaxToolLoopIterations(path)).toBe(DEFAULT_MAX_TOOL_LOOP_ITERATIONS);
	});

	it('defaults when [tools] omits max_tool_loop_iterations', () => {
		const path = writeConfig(`[tools]\n`);
		expect(loadMaxToolLoopIterations(path)).toBe(DEFAULT_MAX_TOOL_LOOP_ITERATIONS);
	});

	it('reads an explicit positive integer', () => {
		const path = writeConfig(`[tools]\nmax_tool_loop_iterations = 12`);
		expect(loadMaxToolLoopIterations(path)).toBe(12);
	});

	it('rejects a non-integer / non-positive value', () => {
		expect(() =>
			loadMaxToolLoopIterations(writeConfig(`[tools]\nmax_tool_loop_iterations = 0`)),
		).toThrow(ConfigError);
		expect(() =>
			loadMaxToolLoopIterations(writeConfig(`[tools]\nmax_tool_loop_iterations = 2.5`)),
		).toThrow(ConfigError);
		expect(() =>
			loadMaxToolLoopIterations(writeConfig(`[tools]\nmax_tool_loop_iterations = "lots"`)),
		).toThrow(ConfigError);
	});

	it('rejects a non-table [tools] entry', () => {
		expect(() => loadMaxToolLoopIterations(writeConfig(`tools = "nope"`))).toThrow(ConfigError);
	});
});

describe('loadTaskModelConfig', () => {
	it('returns null when task_model is absent', () => {
		expect(loadTaskModelConfig(writeConfig(``))).toBeNull();
	});

	it('accepts the bare-string form (→ private: false)', () => {
		const path = writeConfig(`task_model = "groq::llama"`);
		expect(loadTaskModelConfig(path)).toEqual({ model: 'groq::llama', private: false });
		// loadTaskModel still returns just the model string for existing callers.
		expect(loadTaskModel(path)).toBe('groq::llama');
	});

	it('accepts the [task_model] table form with an explicit private flag', () => {
		const path = writeConfig(`[task_model]\nmodel = "dirac::qwen"\nprivate = true`);
		expect(loadTaskModelConfig(path)).toEqual({ model: 'dirac::qwen', private: true });
		expect(loadTaskModel(path)).toBe('dirac::qwen');
	});

	it('defaults private to false when the table omits it', () => {
		const path = writeConfig(`[task_model]\nmodel = "dirac::qwen"`);
		expect(loadTaskModelConfig(path)).toEqual({ model: 'dirac::qwen', private: false });
	});

	it('rejects a malformed model id in either form', () => {
		expect(() => loadTaskModelConfig(writeConfig(`task_model = "no-separator"`))).toThrow(
			ConfigError,
		);
		expect(() => loadTaskModelConfig(writeConfig(`[task_model]\nmodel = "no-separator"`))).toThrow(
			ConfigError,
		);
	});

	it('rejects a missing model in the table form', () => {
		expect(() => loadTaskModelConfig(writeConfig(`[task_model]\nprivate = true`))).toThrow(
			ConfigError,
		);
	});

	it('rejects a non-boolean private flag', () => {
		expect(() =>
			loadTaskModelConfig(writeConfig(`[task_model]\nmodel = "e::m"\nprivate = "yes"`)),
		).toThrow(ConfigError);
	});

	it('rejects an array task_model', () => {
		expect(() => loadTaskModelConfig(writeConfig(`task_model = ["e::m"]`))).toThrow(ConfigError);
	});
});

describe('model_prompt_styles / model_prompt_hints', () => {
	it('validates per-model styles but stores them RAW (kind-aware normalization is deferred)', () => {
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "comfy"
base_url = "http://localhost:8188/v1"
[endpoints.model_prompt_styles]
  "illustrious-xl" = "danbooru"
  "flux-2-klein" = "natural-language"
[endpoints.model_prompt_hints]
  "illustrious-xl" = "prefix: masterpiece, best quality"
			`),
		)[0];
		// The "danbooru" alias is accepted but NOT canonicalized here — the raw
		// value is kept so models.ts can normalize it against the model's kind.
		expect(ep.modelPromptStyles).toEqual({
			'illustrious-xl': 'danbooru',
			'flux-2-klein': 'natural-language',
		});
		expect(ep.modelPromptHints).toEqual({
			'illustrious-xl': 'prefix: masterpiece, best quality',
		});
	});

	it('accepts a cross-medium alias verbatim (resolved per-kind later, not at load)', () => {
		// `structured` is a valid alias in BOTH mediums (image json / video
		// structured-cinematic). It must be stored raw so a video model resolves
		// it to structured-cinematic — canonicalizing at load would lock it to the
		// image `json` and silently downgrade the video model. Regression guard for
		// the colliding-alias bug.
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "comfy"
base_url = "http://localhost:8188/v1"
[endpoints.model_prompt_styles]
  "wan-2.2" = "structured"
			`),
		)[0];
		expect(ep.modelPromptStyles).toEqual({ 'wan-2.2': 'structured' });
	});

	it('defaults both to empty objects when absent', () => {
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://localhost:9/v1"
			`),
		)[0];
		expect(ep.modelPromptStyles).toEqual({});
		expect(ep.modelPromptHints).toEqual({});
	});

	it('accepts video style keys + aliases (config is kind-blind at load)', () => {
		// model_prompt_styles is keyed by upstream id and can't know a model's
		// kind at load, so it must accept image OR video styles. Kind-appropriate
		// selection happens later in models.ts; values are kept raw.
		const ep = loadEndpoints(
			writeConfig(`
[[endpoints]]
id = "comfy"
base_url = "http://localhost:8188/v1"
[endpoints.model_prompt_styles]
  "ltx-2.3" = "cinematic-prose"
  "wan-2.2" = "wan"
			`),
		)[0];
		expect(ep.modelPromptStyles).toEqual({
			'ltx-2.3': 'cinematic-prose',
			'wan-2.2': 'wan',
		});
	});

	it('rejects an unknown style value', () => {
		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://localhost:9/v1"
[endpoints.model_prompt_styles]
  "m" = "photorealistic"
				`),
			),
		).toThrow(ConfigError);
	});

	it('rejects a non-table model_prompt_styles', () => {
		expect(() =>
			loadEndpoints(
				writeConfig(`
[[endpoints]]
id = "x"
base_url = "http://localhost:9/v1"
model_prompt_styles = "nope"
				`),
			),
		).toThrow(ConfigError);
	});
});

describe('loadImageEnhancementConfig', () => {
	it('returns null when the block is absent', () => {
		expect(loadImageEnhancementConfig(writeConfig(``))).toBeNull();
	});

	it('parses model + defaults', () => {
		const cfg = loadImageEnhancementConfig(
			writeConfig(`
[image_enhancement]
model = "groq::llama-3.3-70b"
			`),
		);
		expect(cfg).toEqual({
			model: 'groq::llama-3.3-70b',
			maxTokens: DEFAULT_IMAGE_ENHANCEMENT_MAX_TOKENS,
			temperature: DEFAULT_IMAGE_ENHANCEMENT_TEMPERATURE,
			styleInstructionOverrides: {},
		});
	});

	it('honors max_tokens / temperature / style_instructions overrides', () => {
		const cfg = loadImageEnhancementConfig(
			writeConfig(`
[image_enhancement]
model = "groq::m"
max_tokens = 200
temperature = 0.3
[image_enhancement.style_instructions]
  "booru" = "custom booru wording"
			`),
		);
		expect(cfg?.maxTokens).toBe(200);
		expect(cfg?.temperature).toBe(0.3);
		// Override key normalized from the "booru" alias to canonical "booru-tags".
		expect(cfg?.styleInstructionOverrides).toEqual({ 'booru-tags': 'custom booru wording' });
	});

	it('rejects a malformed model and an unknown override style', () => {
		expect(() =>
			loadImageEnhancementConfig(writeConfig(`[image_enhancement]\nmodel = "no-separator"`)),
		).toThrow(ConfigError);
		expect(() =>
			loadImageEnhancementConfig(
				writeConfig(
					`[image_enhancement]\nmodel = "g::m"\n[image_enhancement.style_instructions]\n  "bogus" = "x"`,
				),
			),
		).toThrow(ConfigError);
	});
});

describe('loadMemoryModelConfig', () => {
	it('returns null when the block is absent', () => {
		expect(loadMemoryModelConfig(writeConfig(``))).toBeNull();
	});

	it('parses model + defaults (no window)', () => {
		const cfg = loadMemoryModelConfig(writeConfig(`\n[memory_model]\nmodel = "gpu::qwen-32b"\n`));
		expect(cfg).toEqual({
			model: 'gpu::qwen-32b',
			maxTokens: DEFAULT_MEMORY_MODEL_MAX_TOKENS,
			temperature: DEFAULT_MEMORY_MODEL_TEMPERATURE,
			activeHours: '',
			timezone: 'UTC',
			overviewMaxChars: DEFAULT_MEMORY_OVERVIEW_MAX_CHARS,
		});
	});

	it('honors max_tokens / temperature / active_hours / timezone / overview_max_chars', () => {
		const cfg = loadMemoryModelConfig(
			writeConfig(`
[memory_model]
model = "gpu::m"
max_tokens = 1500
temperature = 0.1
active_hours = "02:00-06:00"
timezone = "America/New_York"
overview_max_chars = 4000
			`),
		);
		expect(cfg).toEqual({
			model: 'gpu::m',
			maxTokens: 1500,
			temperature: 0.1,
			activeHours: '02:00-06:00',
			timezone: 'America/New_York',
			overviewMaxChars: 4000,
		});
	});

	it('rejects an overview_max_chars that is too small to be a useful map', () => {
		// Below a few hundred chars it can't name enough threads to be a search
		// signpost, and the model is being asked for a length it can't hit.
		for (const bad of ['0', '100', '-1', '2500.5', '"lots"']) {
			expect(() =>
				loadMemoryModelConfig(
					writeConfig(`[memory_model]\nmodel = "g::m"\noverview_max_chars = ${bad}`),
				),
			).toThrow(ConfigError);
		}
	});

	it('rejects a malformed model, a bad active_hours, and an unknown timezone', () => {
		expect(() => loadMemoryModelConfig(writeConfig(`[memory_model]\nmodel = "no-sep"`))).toThrow(
			ConfigError,
		);
		expect(() =>
			loadMemoryModelConfig(writeConfig(`[memory_model]\nmodel = "g::m"\nactive_hours = "2-6"`)),
		).toThrow(ConfigError);
		expect(() =>
			loadMemoryModelConfig(
				writeConfig(`[memory_model]\nmodel = "g::m"\nactive_hours = "25:00-06:00"`),
			),
		).toThrow(ConfigError);
		expect(() =>
			loadMemoryModelConfig(
				writeConfig(`[memory_model]\nmodel = "g::m"\ntimezone = "Mars/Phobos"`),
			),
		).toThrow(ConfigError);
	});
});

describe('loadMaxToolResultChars', () => {
	it('defaults when [tools] is absent', () => {
		const path = writeConfig(`task_model = "e::m"`);
		expect(loadMaxToolResultChars(path)).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
	});

	it('defaults when the key is absent from a present [tools] block', () => {
		const path = writeConfig(`[tools]\nmax_tool_loop_iterations = 4\n`);
		expect(loadMaxToolResultChars(path)).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
	});

	it('accepts an explicit cap', () => {
		const path = writeConfig(`[tools]\nmax_tool_result_chars = 8192\n`);
		expect(loadMaxToolResultChars(path)).toBe(8192);
	});

	it('accepts 0, which disables capping entirely', () => {
		const path = writeConfig(`[tools]\nmax_tool_result_chars = 0\n`);
		expect(loadMaxToolResultChars(path)).toBe(0);
	});

	it('rejects a cap below the structural-truncation floor', () => {
		// Below ~243 chars not even the minimal JSON envelope fits, so a capped result
		// would degrade to a raw character slice — the very thing structural truncation
		// exists to avoid. Refusing to boot beats silently doing the broken thing.
		const path = writeConfig(`[tools]\nmax_tool_result_chars = 512\n`);
		expect(() => loadMaxToolResultChars(path)).toThrow(ConfigError);
		expect(() => loadMaxToolResultChars(path)).toThrow(String(MIN_MAX_TOOL_RESULT_CHARS));
	});

	it('accepts exactly the floor', () => {
		const path = writeConfig(`[tools]\nmax_tool_result_chars = ${MIN_MAX_TOOL_RESULT_CHARS}\n`);
		expect(loadMaxToolResultChars(path)).toBe(MIN_MAX_TOOL_RESULT_CHARS);
	});

	it('rejects negatives and non-integers', () => {
		for (const v of ['-1', '1.5', '"lots"']) {
			const path = writeConfig(`[tools]\nmax_tool_result_chars = ${v}\n`);
			expect(() => loadMaxToolResultChars(path)).toThrow(ConfigError);
		}
	});
});

describe('loadVisionConfig', () => {
	it('defaults when [vision] is absent', () => {
		const path = writeConfig(`task_model = "e::m"`);
		expect(loadVisionConfig(path)).toEqual({
			maxImageDim: DEFAULT_VISION_MAX_IMAGE_DIM,
			imageQuality: DEFAULT_VISION_IMAGE_QUALITY,
		});
	});

	it('accepts explicit values', () => {
		const path = writeConfig(`[vision]\nmax_image_dim = 1024\nimage_quality = 90\n`);
		expect(loadVisionConfig(path)).toEqual({ maxImageDim: 1024, imageQuality: 90 });
	});

	it('accepts 0, which inlines originals at full resolution', () => {
		const path = writeConfig(`[vision]\nmax_image_dim = 0\n`);
		expect(loadVisionConfig(path).maxImageDim).toBe(0);
	});

	it('rejects a max_image_dim that would destroy the image', () => {
		// Without a floor, `max_image_dim = 1` is accepted and every image is resized
		// to 1x1. The model dutifully "reads" it and describes a blank square, with no
		// error anywhere to explain why vision stopped working. Silent quality
		// destruction is worse than a startup error.
		const path = writeConfig(`[vision]\nmax_image_dim = 1\n`);
		expect(() => loadVisionConfig(path)).toThrow(ConfigError);
		expect(() => loadVisionConfig(path)).toThrow(String(MIN_VISION_MAX_IMAGE_DIM));
	});

	it('accepts exactly the floor', () => {
		const path = writeConfig(`[vision]\nmax_image_dim = ${MIN_VISION_MAX_IMAGE_DIM}\n`);
		expect(loadVisionConfig(path).maxImageDim).toBe(MIN_VISION_MAX_IMAGE_DIM);
	});

	it('rejects an out-of-range image_quality', () => {
		for (const v of ['0', '101', '-5', '82.5']) {
			const path = writeConfig(`[vision]\nimage_quality = ${v}\n`);
			expect(() => loadVisionConfig(path)).toThrow(ConfigError);
		}
	});
});
