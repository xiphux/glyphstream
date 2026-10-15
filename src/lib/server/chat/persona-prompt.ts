/**
 * The persona system prompt's prose: the user's name, "about", custom
 * instructions, saved memories and the conversation-topic overview, rendered
 * as labelled sections. Pure string work over rows the caller has loaded;
 * `persona-context.ts` decides what to load and which rendering to use.
 *
 * Lives here rather than beside the queries that load the rows: this is
 * instructions written for the model, and the queries layer reads and writes
 * the database.
 */
import type { ContextSegmentKey, UserPreferences } from '#lib/types/api.js';
import type { Memory, MemoryIndexRow } from '../db/queries/memories';

/**
 * Compose the "Saved memories" section appended to the persona system
 * prompt. Returns null when there's nothing to show so the caller can omit
 * the section header entirely — a "(no memories yet)" line would just
 * be noise; the tool descriptions already teach the model that
 * save_memory exists.
 *
 * Two renderings, chosen by `composePersonaPrompt`:
 *
 * - **Inline** (default, small stores): every row as `[<id>] <content>`, the
 *   full body in the prompt so nothing has to be recalled.
 * - **Tiered** (`recallMode`, over `MEMORY_INLINE_BUDGET_CHARS`): the hot tier
 *   (`list`, ranked by `selectMemoryTiers`) is inlined in full as
 *   `[<id>] <content>`, and the cold tail (`opts.index`) follows as
 *   `[<id>] <topic>` — topic only, so a large store still fits. The model reads a
 *   cold entry's full body back via `recall_memory` (by id, or by query). Cold
 *   rows with a null `topic` fall back to a content snippet. Needs no embedding
 *   model — recall-by-id is pure SQLite.
 *
 * In both cases the bracketed id is what the model passes to
 * update_memory / forget_memory (and, for a cold entry, recall_memory).
 */
export function composeMemorySection(
	list: Memory[],
	opts: { recallMode?: boolean; index?: MemoryIndexRow[] } = {},
): string | null {
	if (opts.recallMode) {
		const cold = opts.index ?? [];
		if (list.length === 0 && cold.length === 0) return null;

		// Defensive: no hot tier (nothing fit the budget) — pure topic index, the
		// phase-1 rendering. In practice a single body (≤800 chars) always fits a
		// 4000-char budget, so this branch is a safety net, not the common path.
		if (list.length === 0) {
			const header =
				'Saved memory index (durable facts about the user, carried across conversations). Only a short topic for each memory is shown here — the full text is not loaded. Call recall_memory with a list of ids to read the full text of specific entries, or with a query to find entries by meaning. Each line is prefixed with its id in square brackets — pass that id to recall_memory, update_memory, or forget_memory. To add a new memory, call save_memory.';
			const lines = cold.map((m) => `[${m.id}] ${m.topic ?? m.snippet}`);
			return `${header}\n\n${lines.join('\n')}`;
		}

		// Over budget: the highest-scored memories inline in full, the rest by topic.
		const header =
			'Saved memories (durable facts about the user, carried across conversations). The most relevant are shown in full first; any remaining ones are listed below by topic only. Each line is prefixed with its id in square brackets — pass that id to update_memory or forget_memory. To read the full text of a topic-only entry, call recall_memory with its id (or with a query to search by meaning). To add a new memory, call save_memory.';
		const hotBlock = list.map((m) => `[${m.id}] ${m.content}`).join('\n');
		if (cold.length === 0) return `${header}\n\n${hotBlock}`;
		const coldBlock =
			'More saved memories (topic only — call recall_memory with the id for the full text):\n' +
			cold.map((m) => `[${m.id}] ${m.topic ?? m.snippet}`).join('\n');
		return `${header}\n\n${hotBlock}\n\n${coldBlock}`;
	}
	if (list.length === 0) return null;
	const header =
		'Saved memories (durable facts about the user, carried across conversations). Each line is prefixed with its id in square brackets — pass that id to forget_memory or update_memory. To add a new memory, call save_memory.';
	const lines = list.map((m) => `[${m.id}] ${m.content}`);
	return `${header}\n\n${lines.join('\n')}`;
}

/** Separator between persona sections on the wire. The breakdown prices each
 *  section's own text and ignores this, so a segment's `chars` is a hair under
 *  its true wire cost — immaterial at 2 chars a join. */
export const PERSONA_PART_SEPARATOR = '\n\n';

export interface PersonaPart {
	key: Extract<ContextSegmentKey, `persona:${string}`>;
	text: string;
}

/**
 * Compose the three personalization fields plus the saved-memory index
 * into a single system prompt for the model. Each non-empty field
 * becomes its own labeled section; empty fields are omitted (no "Name:
 * (blank)" leaks). Returns null when all four (name, about, custom,
 * memories) are empty — the caller (conversation-create handler)
 * treats null as "no system prompt for this conversation."
 *
 * Memories ride in the same prompt because they ride the same gate:
 * the conversation's `personalization` category toggle seals every
 * avenue that ships personal context to the model. A user with no
 * prefs but saved memories still gets a prompt; flipping the toggle
 * off drops the whole thing.
 *
 * Returned as labeled parts rather than one pre-joined string so the context
 * breakdown can price each section separately (the memory index and the topic
 * overview are the two that grow without bound). `composePersonaSystemPrompt`
 * joins them for the wire; nothing else should depend on the split.
 *
 * The labels are intentionally plain English rather than YAML/JSON
 * keys: we're authoring instructions for the model to read, and
 * natural-language section headers prime it better than a structured
 * envelope that the model has to parse.
 *
 * When `recallMode` is set (the store is over budget), the memory section is
 * tiered: `memories` carries the hot rows inlined in full and `index` the cold
 * tail rendered as the compact `[id] topic` list (composeMemorySection handles
 * the rendering). The caller decides the mode and does the split —
 * `composePersonaPrompt` sets it when the store exceeds
 * `MEMORY_INLINE_BUDGET_CHARS` — because that check needs a size probe that lives
 * request-side.
 */
export function composePersonaParts(
	prefs: UserPreferences,
	memories: Memory[] = [],
	opts: {
		recallMode?: boolean;
		index?: MemoryIndexRow[];
		conversationOverview?: string | null;
	} = {},
): PersonaPart[] {
	const parts: PersonaPart[] = [];
	const name = prefs.name.trim();
	const about = prefs.aboutYou.trim();
	const custom = prefs.customInstructions.trim();
	if (name) {
		parts.push({
			key: 'persona:name',
			text: `The user's name is ${name}. Refer to them by this name when natural.`,
		});
	}
	if (about) {
		parts.push({ key: 'persona:about', text: `About the user:\n${about}` });
	}
	if (custom) {
		parts.push({ key: 'persona:instructions', text: `Additional instructions:\n${custom}` });
	}
	const memorySection = composeMemorySection(memories, {
		recallMode: opts.recallMode,
		index: opts.index,
	});
	if (memorySection) {
		parts.push({ key: 'persona:memories', text: memorySection });
	}
	const overview = opts.conversationOverview?.trim();
	if (overview) {
		parts.push({
			key: 'persona:overview',
			text:
				'Topics from earlier conversations with this user — a rough map of what has been ' +
				'discussed, so you know what past threads exist. Call search_conversations to pull the ' +
				'actual details of any of these; treat it as an index of what you could search, not as ' +
				'facts you were told, and separate from the saved memories above.\n\n' +
				overview,
		});
	}
	return parts;
}

/** Joined rendering of `composePersonaParts` — the string that actually ships
 *  as the system prompt. Null when every section is empty. */
export function composePersonaSystemPrompt(
	prefs: UserPreferences,
	memories: Memory[] = [],
	opts: {
		recallMode?: boolean;
		index?: MemoryIndexRow[];
		conversationOverview?: string | null;
	} = {},
): string | null {
	const parts = composePersonaParts(prefs, memories, opts);
	return parts.length === 0 ? null : parts.map((p) => p.text).join(PERSONA_PART_SEPARATOR);
}
