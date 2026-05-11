import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigError, loadEndpoints } from '$lib/server/endpoints/config';

// Stub $env/dynamic/private so we can control api_key_env resolution
// without touching the real process env.
const envStub = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({
	env: new Proxy({} as Record<string, string>, {
		get: (_t, k: string) => envStub.values[k]
	})
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
			providerQuirk: 'passthrough'
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
