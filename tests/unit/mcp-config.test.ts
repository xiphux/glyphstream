import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpConfigError, loadMcpServers } from '$lib/server/mcp/config';

const envStub = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({
	env: new Proxy({} as Record<string, string>, {
		get: (_t, k: string) => envStub.values[k],
	}),
}));

const tmpDirs: string[] = [];
function writeConfig(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'gs-mcp-config-'));
	tmpDirs.push(dir);
	const path = join(dir, 'config.toml');
	writeFileSync(path, toml);
	return path;
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	envStub.values = {};
});

describe('loadMcpServers', () => {
	it('returns [] when the section is absent', () => {
		const path = writeConfig(`# no mcp_servers section`);
		expect(loadMcpServers(path)).toEqual([]);
	});

	it('parses a minimal stdio server', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "npx"
		`);
		const servers = loadMcpServers(path);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			id: 'fs',
			displayName: 'fs',
			transport: 'stdio',
			command: 'npx',
			args: [],
			env: {},
			timeoutSeconds: 30,
			idleTimeoutSeconds: 900,
		});
	});

	it('parses a minimal http server', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "linear"
transport = "http"
url = "https://mcp.linear.app/mcp"
		`);
		const servers = loadMcpServers(path);
		expect(servers[0]).toMatchObject({
			id: 'linear',
			transport: 'http',
			url: 'https://mcp.linear.app/mcp',
			apiKey: null,
			postOnly: false,
		});
	});

	it('parses post_only on an http server', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fastmail"
transport = "http"
url = "https://api.fastmail.com/mcp"
post_only = true
		`);
		expect(loadMcpServers(path)[0]).toMatchObject({ id: 'fastmail', postOnly: true });
	});

	it('rejects post_only on a stdio server', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "npx"
post_only = true
		`);
		expect(() => loadMcpServers(path)).toThrow(/post_only.*only valid for transport="http"/);
	});

	it('rejects a non-boolean post_only', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fastmail"
transport = "http"
url = "https://api.fastmail.com/mcp"
post_only = "yes"
		`);
		expect(() => loadMcpServers(path)).toThrow(McpConfigError);
	});

	it('defaults defer_tools to false', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "npx"
		`);
		expect(loadMcpServers(path)[0].deferTools).toBe(false);
	});

	it('parses defer_tools = true', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "github"
transport = "http"
url = "https://api.githubcopilot.com/mcp/"
defer_tools = true
		`);
		expect(loadMcpServers(path)[0].deferTools).toBe(true);
	});

	it('rejects a non-boolean defer_tools', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "github"
transport = "http"
url = "https://x/mcp"
defer_tools = "yes"
		`);
		expect(() => loadMcpServers(path)).toThrow(McpConfigError);
	});

	it('allows defer_tools alongside auth = "per_user"', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "email"
transport = "http"
url = "https://api.fastmail.com/mcp"
auth = "per_user"
defer_tools = true
		`);
		const s = loadMcpServers(path)[0];
		expect(s.deferTools).toBe(true);
		expect(s.auth).toBe('per_user');
	});

	it('uses display_name when provided', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
display_name = "Filesystem"
transport = "stdio"
command = "npx"
		`);
		expect(loadMcpServers(path)[0].displayName).toBe('Filesystem');
	});

	it('passes args through to stdio servers', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
		`);
		const s = loadMcpServers(path)[0];
		expect(s.transport).toBe('stdio');
		if (s.transport === 'stdio') {
			expect(s.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
		}
	});

	it('resolves env_from entries to env-var values', () => {
		envStub.values.LINEAR_API_KEY = 'sk-linear-123';
		const path = writeConfig(`
[[mcp_servers]]
id = "linear-local"
transport = "stdio"
command = "linear-mcp"
env_from = { LINEAR_API_KEY = "LINEAR_API_KEY" }
		`);
		const s = loadMcpServers(path)[0];
		expect(s.transport).toBe('stdio');
		if (s.transport === 'stdio') {
			expect(s.env).toEqual({ LINEAR_API_KEY: 'sk-linear-123' });
		}
	});

	it('resolves api_key_env on http servers', () => {
		envStub.values.LINEAR_TOKEN = 'tok-abc';
		const path = writeConfig(`
[[mcp_servers]]
id = "linear"
transport = "http"
url = "https://mcp.linear.app/mcp"
api_key_env = "LINEAR_TOKEN"
		`);
		const s = loadMcpServers(path)[0];
		expect(s.transport).toBe('http');
		if (s.transport === 'http') {
			expect(s.apiKey).toBe('tok-abc');
		}
	});

	it('respects per-server timeout and idle_timeout overrides', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "stdio"
command = "x"
timeout_seconds = 5
idle_timeout_seconds = 60
		`);
		expect(loadMcpServers(path)[0]).toMatchObject({
			timeoutSeconds: 5,
			idleTimeoutSeconds: 60,
		});
	});

	it('accepts idle_timeout_seconds = 0 to disable reaping', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "stdio"
command = "x"
idle_timeout_seconds = 0
		`);
		expect(loadMcpServers(path)[0].idleTimeoutSeconds).toBe(0);
	});

	it('rejects malformed ids', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "Bad Id!"
transport = "stdio"
command = "x"
		`);
		expect(() => loadMcpServers(path)).toThrow(McpConfigError);
	});

	it('rejects duplicate ids', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "x"

[[mcp_servers]]
id = "fs"
transport = "stdio"
command = "y"
		`);
		expect(() => loadMcpServers(path)).toThrow(/Duplicate mcp_servers id/);
	});

	it('rejects unknown transports', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "carrier-pigeon"
		`);
		expect(() => loadMcpServers(path)).toThrow(/transport "carrier-pigeon"/);
	});

	it('rejects stdio without command', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "stdio"
		`);
		expect(() => loadMcpServers(path)).toThrow(/'command'/);
	});

	it('rejects http without url', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "http"
		`);
		expect(() => loadMcpServers(path)).toThrow(/'url'/);
	});

	it('rejects http with stdio-only fields', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "http"
url = "https://x"
command = "ignored"
		`);
		expect(() => loadMcpServers(path)).toThrow(/only valid for transport="stdio"/);
	});

	it('rejects malformed url on http', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "http"
url = "ftp://x"
		`);
		expect(() => loadMcpServers(path)).toThrow(/url must start with/);
	});

	it('rejects unset env vars referenced by api_key_env', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "http"
url = "https://x"
api_key_env = "MISSING_VAR"
		`);
		expect(() => loadMcpServers(path)).toThrow(/MISSING_VAR/);
	});

	it('rejects unset env vars referenced by env_from', () => {
		const path = writeConfig(`
[[mcp_servers]]
id = "x"
transport = "stdio"
command = "x"
env_from = { FOO = "MISSING_VAR" }
		`);
		expect(() => loadMcpServers(path)).toThrow(/MISSING_VAR/);
	});

	it('rejects mcp_servers that is not an array', () => {
		const path = writeConfig(`
mcp_servers = "not an array"
		`);
		expect(() => loadMcpServers(path)).toThrow(/must be an array/);
	});
});
