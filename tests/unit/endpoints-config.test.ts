import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ConfigError,
	DEFAULT_MAX_TOOL_LOOP_ITERATIONS,
	loadEmbeddingsConfig,
	loadEndpoints,
	loadMaxToolLoopIterations,
	loadNotificationsConfig,
	loadRerankConfig,
	loadSearchConfig,
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
		});
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

	it('throws when the file does not exist', () => {
		expect(() => loadEndpoints('/nonexistent/path/config.toml')).toThrow(ConfigError);
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
		});
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
