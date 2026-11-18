/**
 * A config.toml key that no loader reads is reported at load, not silently
 * ignored: a one-character typo of a documented key otherwise runs on the
 * default with a clean boot. And the documented keys themselves (the example
 * file and the docs' TOML snippets) must not trip the warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	loadEmbeddingsConfig,
	loadEndpoints,
	loadImageEnhancementConfig,
	loadMaxQueuedGenerationsPerUser,
	loadMaxToolResultChars,
	loadMemoryModelConfig,
	loadNotificationsConfig,
	loadRerankConfig,
	loadScheduledTasksConfig,
	loadSearchConfig,
	loadTaskModelConfig,
	loadVisionConfig,
	loadCheckInsConfig,
} from '#lib/server/endpoints/config.js';
import { loadMcpServers } from '#lib/server/mcp/config.js';
import { loadCodeInterpreterConfig } from '#lib/server/code-interpreter/config.js';
import { CONFIG_SECTIONS, warnUnknownConfigKeys } from '#lib/server/config/toml.js';
import { resetConfigCachesForTests } from '#lib/server/util/config-cache.js';

const tmpDirs: string[] = [];
function writeConfig(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'gs-config-'));
	tmpDirs.push(dir);
	const path = join(dir, 'config.toml');
	writeFileSync(path, toml);
	return path;
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
	resetConfigCachesForTests();
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function warnings(): string[] {
	return warn.mock.calls.map((c) => String(c[0]));
}

describe('a typo in config.toml warns and still loads', () => {
	it.each<[string, string, (path: string) => unknown, string]>([
		[
			'[[endpoints]]',
			'[[endpoints]]\nid = "a"\ndisplay_name = "A"\nbase_url = "http://127.0.0.1:1/v1"\nmax_concurent = 1\n',
			loadEndpoints,
			"unknown key 'max_concurent' is ignored (did you mean 'max_concurrent'?)",
		],
		[
			'[[mcp_servers]]',
			'[[mcp_servers]]\nid = "fs"\ntransport = "stdio"\ncommand = "npx"\ndefer_tool = true\n',
			loadMcpServers,
			"unknown key 'defer_tool'",
		],
		[
			'[task_model]',
			'[task_model]\nmodel = "a::b"\nprivat = true\n',
			loadTaskModelConfig,
			"unknown key 'privat'",
		],
		[
			'[notifications]',
			'[notifications]\nvapid_public = "k"\nvapid_private_env = "PATH"\nvapid_subject = "mailto:a@b.c"\nvapid_subjct = "x"\n',
			loadNotificationsConfig,
			"unknown key 'vapid_subjct'",
		],
		[
			'[image_enhancement]',
			'[image_enhancement]\nmodel = "a::b"\nmax_token = 10\n',
			loadImageEnhancementConfig,
			"unknown key 'max_token'",
		],
		[
			'[memory_model]',
			'[memory_model]\nmodel = "a::b"\ntime_zone = "UTC"\n',
			loadMemoryModelConfig,
			"unknown key 'time_zone'",
		],
		[
			'[tools]',
			'[tools]\nmax_tool_result_char = 2048\n',
			loadMaxToolResultChars,
			"unknown key 'max_tool_result_char'",
		],
		[
			'[limits]',
			'[limits]\nmax_queued_generation_per_user = 3\n',
			loadMaxQueuedGenerationsPerUser,
			"unknown key 'max_queued_generation_per_user'",
		],
		[
			'[vision]',
			'[vision]\nmax_image_dimension = 512\n',
			loadVisionConfig,
			"unknown key 'max_image_dimension'",
		],
		[
			'[search]',
			'[search]\nurl = "http://127.0.0.1:1"\ntimeout = 5\n',
			loadSearchConfig,
			"unknown key 'timeout'",
		],
		[
			'[embeddings]',
			'[embeddings]\nendpoint_id = "a"\nmodel_id = "m"\nquery_prefx = ""\n',
			loadEmbeddingsConfig,
			"unknown key 'query_prefx'",
		],
		[
			'[rerank]',
			'[rerank]\nendpoint_id = "a"\nmodel_id = "m"\ntopn = 5\n',
			loadRerankConfig,
			"unknown key 'topn'",
		],
		[
			'[scheduled_tasks]',
			'[scheduled_tasks]\nkeep_run = 3\n',
			loadScheduledTasksConfig,
			"unknown key 'keep_run'",
		],
		['[check_ins]', '[check_ins]\nenable = false\n', loadCheckInsConfig, "unknown key 'enable'"],
		[
			'[code_interpreter]',
			'[code_interpreter]\nenable = false\n',
			loadCodeInterpreterConfig,
			"unknown key 'enable' is ignored (did you mean 'enabled'?)",
		],
	])('%s', (section, toml, load, message) => {
		const path = writeConfig(toml);
		expect(() => load(path)).not.toThrow();
		const label = section.startsWith('[[') ? `${section} #0` : section;
		const [only, ...rest] = warnings();
		expect(rest).toEqual([]);
		expect(only).toMatch(/^\[config\] /);
		expect(only).toContain(`${label} in ${path}: ${message}`);
	});

	it('names an unknown section', () => {
		const path = writeConfig('[visoin]\nmax_image_dim = 512\n');
		expect(loadVisionConfig(path)).toMatchObject({ maxImageDim: 1568 });
		expect(warnings()).toEqual([
			`[config] ${path}: unknown section [visoin] is ignored (did you mean 'vision'?)`,
		]);
	});

	it('accepts the bare root task_model, and flags one that landed in an endpoint', () => {
		const top = writeConfig(
			'task_model = "a::b"\n[[endpoints]]\nid = "a"\nbase_url = "http://x"\n',
		);
		loadEndpoints(top);
		expect(warnings()).toEqual([]);

		const below = writeConfig(
			'[[endpoints]]\nid = "a"\nbase_url = "http://x"\ntask_model = "a::b"\n',
		);
		loadEndpoints(below);
		expect(warnings()).toEqual([
			`[config] [[endpoints]] #0 in ${below}: unknown key 'task_model' is ignored`,
		]);
	});

	it('warns once per load, not once per section read', () => {
		const path = writeConfig('[vision]\nmax_image_dimension = 512\n');
		loadVisionConfig(path);
		loadEndpoints(path);
		loadMaxToolResultChars(path);
		expect(warnings()).toHaveLength(1);
	});
});

/**
 * The (section, key) pairs a TOML-ish text sets, commented out or not: header
 * lines open a section, `key = …` lines add to it. Indented and quoted keys sit
 * under sub-tables of operator-chosen names, so they're skipped, as are
 * uppercase ones (env var names under `env_from`).
 */
function documentedConfig(text: string): Record<string, unknown> {
	const parsed: Record<string, unknown> = {};
	let current: Record<string, unknown> | null = parsed;
	for (const line of text.split('\n')) {
		const body = line.replace(/^#/, '');
		const header = /^\s?(\[\[?)([a-z_]+)(?:\.([a-z_]+))?\]\]?\s*(?:#.*)?$/.exec(body);
		if (header) {
			const [, open, name, sub] = header;
			if (sub !== undefined) {
				const parent = (
					open === '[' && Array.isArray(parsed[name])
						? (parsed[name] as unknown[]).at(-1)
						: parsed[name]
				) as Record<string, unknown> | undefined;
				if (parent) parent[sub] = {};
				current = null;
			} else if (open === '[[') {
				current = {};
				parsed[name] = [...((parsed[name] as unknown[] | undefined) ?? []), current];
			} else {
				current = (parsed[name] as Record<string, unknown> | undefined) ?? {};
				parsed[name] = current;
			}
			continue;
		}
		const key = /^\s?([a-z_]+)\s*=/.exec(body)?.[1];
		if (key === undefined || current === null) continue;
		// The legacy bare form, shown beside the [task_model] table it replaces.
		if (key === 'task_model') parsed.task_model ??= 'a::b';
		else current[key] = true;
	}
	return parsed;
}

function tomlFences(markdown: string): string {
	return [...markdown.matchAll(/^```toml\n([\s\S]*?)^```/gm)].map((m) => m[1]).join('\n');
}

describe('the documented keys are all known', () => {
	it('config.toml.example sets no key a loader would warn about', () => {
		const parsed = documentedConfig(readFileSync('config.toml.example', 'utf8'));
		// Guard the extractor itself: the example documents every section.
		expect(Object.keys(parsed).sort()).toEqual(Object.keys(CONFIG_SECTIONS).sort());
		warnUnknownConfigKeys(parsed, 'config.toml.example');
		expect(warnings()).toEqual([]);
	});

	it.each(readdirSync('docs').filter((f) => f.endsWith('.md')))(
		'docs/%s sets no key a loader would warn about',
		(file) => {
			const text = tomlFences(readFileSync(join('docs', file), 'utf8'));
			warnUnknownConfigKeys(documentedConfig(text), `docs/${file}`);
			expect(warnings()).toEqual([]);
		},
	);
});
