/**
 * Skill activation tools — the model's path into an on-disk skill bundle.
 *
 * Progressive disclosure (agentskills.io spec):
 *   - Tier 1 (catalog) is injected into the system prompt — see
 *     `composeSkillsCatalog` — not a tool.
 *   - Tier 2 `activate_skill(name)` returns the SKILL.md body (frontmatter
 *     stripped) wrapped in <skill_content>, plus a manifest of bundled
 *     resources (listed, NOT eagerly read).
 *   - Tier 3 `read_skill_file(name, path)` reads one bundled file on demand,
 *     path-jailed to the skill directory.
 *
 * The per-user problem: the registry's `openaiToolDefinitions()` has only
 * static, non-per-user filters (`isAvailable()` takes no context). So both
 * tools register with `isAvailable(): false` — they are NEVER advertised via
 * the static registry — while the message/tool-approval handlers append a
 * dynamically-built definition per request (with the user's skill names as an
 * `enum`, omitted entirely when the user has no enabled skills). The registry
 * entry still exists so the tool-loop's `registry.get(name)` resolves it for
 * execution. Both carry `category: 'skills'` so the per-conversation toggle and
 * the defensive `ctx.disabledFeatures` check seal them together.
 *
 * Unknown/disabled names return a recoverable `isError` result (mirror
 * memories' "No memory with id"), not a throw — the model gets a tool message
 * it can recover from instead of an aborted turn.
 */
import { getEnabledSkillByName } from '../db/queries/skills';
import { parseSkillMd } from '../skills/parse-skill-md';
import { getSkillStore } from '../skills/disk-store';
import { register } from './registry';
import type { OpenAIToolDefinition, Tool, ToolContext, ToolExecution } from './types';

const ACTIVATE_DESCRIPTION =
	'Load the full instructions for one of your available skills (listed in <available_skills>). Call this when the current task matches a skill, BEFORE attempting the task — the returned instructions tell you how to proceed. Returns the skill body plus a manifest of any bundled resource files you can then load with read_skill_file.';

const READ_FILE_DESCRIPTION =
	'Read one bundled file from inside a skill directory (e.g. a reference doc or script the activated skill instructions point to). Resolve relative paths from the skill root. Read-only — files are never executed.';

function skillsDisabled(ctx: ToolContext): boolean {
	return ctx.disabledFeatures.includes('skills');
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

function parseNameArg(args: unknown): { name: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `name` field.' };
	}
	const a = args as { name?: unknown };
	if (typeof a.name !== 'string' || a.name.trim().length === 0) {
		return { error: 'Missing or empty `name` argument.' };
	}
	return { name: a.name.trim() };
}

function parseNameAndPathArgs(args: unknown): { name: string; path: string } | { error: string } {
	const nameResult = parseNameArg(args);
	if ('error' in nameResult) return nameResult;
	const a = args as { path?: unknown };
	if (typeof a.path !== 'string' || a.path.trim().length === 0) {
		return { error: 'Missing or empty `path` argument.' };
	}
	return { name: nameResult.name, path: a.path.trim() };
}

export const activateSkillTool: Tool = {
	// Static fallback definition — present so the registry entry is complete and
	// resolvable by the tool loop, but never advertised (isAvailable: false).
	// The advertised form is built per-request with the per-user enum.
	definition: {
		type: 'function',
		function: {
			name: 'activate_skill',
			description: ACTIVATE_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: { name: { type: 'string', description: 'The skill name to activate.' } },
				required: ['name'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Activate skill', icon: 'sparkles', category: 'skills' },
	isAvailable: () => false,
	async execute(args, ctx): Promise<ToolExecution> {
		if (skillsDisabled(ctx)) return errorResult('Skills are disabled for this conversation.');
		const parsed = parseNameArg(args);
		if ('error' in parsed) return errorResult(parsed.error);

		const ref = getEnabledSkillByName(ctx.userId, parsed.name);
		if (!ref) return errorResult(`No enabled skill named "${parsed.name}".`);

		const store = getSkillStore();
		const raw = await store.readSkillMd(ref.storagePath);
		if (raw === null) {
			return errorResult(`Skill "${ref.name}" has no SKILL.md on disk.`);
		}
		// Strip frontmatter; fall back to the raw text if (unexpectedly) the
		// stored SKILL.md no longer parses.
		const parsedMd = parseSkillMd(raw);
		const body = parsedMd.ok ? parsedMd.skill.body : raw.trim();

		const resources = (await store.listFiles(ref.storagePath)).filter((p) => p !== 'SKILL.md');

		return { content: wrapSkillContent(ref.name, body, resources) };
	},
};

export const readSkillFileTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'read_skill_file',
			description: READ_FILE_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The skill whose directory to read from.' },
					path: {
						type: 'string',
						description: 'Bundle-relative file path, e.g. references/api.md.',
					},
				},
				required: ['name', 'path'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Read skill file', icon: 'file-text', category: 'skills' },
	isAvailable: () => false,
	async execute(args, ctx): Promise<ToolExecution> {
		if (skillsDisabled(ctx)) return errorResult('Skills are disabled for this conversation.');
		const parsed = parseNameAndPathArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);

		const ref = getEnabledSkillByName(ctx.userId, parsed.name);
		if (!ref) return errorResult(`No enabled skill named "${parsed.name}".`);

		const store = getSkillStore();
		let file;
		try {
			file = await store.readFile(ref.storagePath, parsed.path);
		} catch (e) {
			return errorResult((e as Error).message);
		}
		if (file === null) {
			return errorResult(`No file at "${parsed.path}" in skill "${ref.name}".`);
		}
		const text = file.bytes.toString('utf8');
		return {
			content: `<skill_file name="${ref.name}" path="${file.relPath}">\n${text}\n</skill_file>`,
		};
	},
};

/** Wrap an activated skill body + resource manifest per the spec's structured
 *  form, so the model can distinguish skill instructions from conversation
 *  content and knows which bundled files it can load. */
function wrapSkillContent(name: string, body: string, resources: string[]): string {
	const parts = [`<skill_content name="${name}">`, body];
	if (resources.length > 0) {
		const list = resources.map((r) => `- ${r}`).join('\n');
		parts.push(
			`<skill_resources>\nFiles bundled with this skill (load one with read_skill_file when the instructions reference it):\n${list}\n</skill_resources>`,
		);
	}
	parts.push('</skill_content>');
	return parts.join('\n\n');
}

/**
 * Build the per-request advertised definition for `activate_skill`, with the
 * caller's enabled skill names as an `enum` (prevents hallucinated names).
 * Returns null when there are no skills — the caller then omits the tool
 * entirely (the spec: never register a skill-activation tool with no options).
 */
export function activateSkillDefinition(skillNames: string[]): OpenAIToolDefinition | null {
	if (skillNames.length === 0) return null;
	return {
		type: 'function',
		function: {
			name: 'activate_skill',
			description: ACTIVATE_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						enum: skillNames,
						description: 'The name of the skill to activate, from <available_skills>.',
					},
				},
				required: ['name'],
				additionalProperties: false,
			},
		},
	};
}

/** Per-request advertised definition for `read_skill_file`. Same omit-when-empty
 *  contract as `activateSkillDefinition`; `name` is enum-constrained, `path` is
 *  a free string validated (path-jailed) at execution time. */
export function readSkillFileDefinition(skillNames: string[]): OpenAIToolDefinition | null {
	if (skillNames.length === 0) return null;
	return {
		type: 'function',
		function: {
			name: 'read_skill_file',
			description: READ_FILE_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						enum: skillNames,
						description: 'The skill whose directory to read from.',
					},
					path: {
						type: 'string',
						description: 'Bundle-relative file path, e.g. references/api.md.',
					},
				},
				required: ['name', 'path'],
				additionalProperties: false,
			},
		},
	};
}

/**
 * Both skill tools, advertised together when a user has ≥1 enabled skill and
 * the conversation hasn't disabled the `skills` category. Returns [] otherwise.
 * Centralizes the omit-when-empty + gate logic so the two request handlers
 * (messages + tool-approval) stay identical.
 */
export function skillToolDefinitions(
	skillNames: string[],
	disabledFeatures: readonly string[],
): OpenAIToolDefinition[] {
	if (disabledFeatures.includes('skills')) return [];
	const defs: OpenAIToolDefinition[] = [];
	const activate = activateSkillDefinition(skillNames);
	if (activate) defs.push(activate);
	const readFile = readSkillFileDefinition(skillNames);
	if (readFile) defs.push(readFile);
	return defs;
}

register(activateSkillTool);
register(readSkillFileTool);
