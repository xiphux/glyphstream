import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ConfigError,
	loadEndpoints,
	loadNotificationsConfig,
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
		});
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
