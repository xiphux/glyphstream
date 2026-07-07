/**
 * Shared size caps for a memory row's `content` and `topic`, enforced both at
 * author time (the `save_memory` / `update_memory` tools) and by the dreaming
 * pass (`consolidation.ts`) so a model-authored memory and a consolidated one
 * render at the same scale. Kept in one side-effect-free module so the two
 * enforcement sites can't drift — do NOT import `tools/memory.ts` for these, it
 * registers tools as an import side effect.
 *
 * `content` is a short paragraph's worth of durable prose (a sentence up to a
 * few), not a bare atomic fact: bodies no longer cost system-prompt tokens for
 * the cold tail (tiering indexes them by topic), so a memory can carry the
 * useful texture around a fact, not just the fact.
 */
export const MEMORY_MAX_CONTENT_CHARS = 800;

/** Max length of a memory's short `topic` label — matches the over-budget index
 *  snippet width so a topic and a fallback snippet render at the same scale. */
export const MEMORY_MAX_TOPIC_CHARS = 80;

/**
 * Normalize a memory `content` or `topic` to its stored form: trim the ends and
 * collapse every internal whitespace run (including hard line breaks a "short
 * paragraph" might carry) to a single space. Both render paths emit one
 * `[id] content` / `[id] topic` line per memory (`composeMemorySection`,
 * `renderMemories`), so a mid-body newline would inject a spurious un-prefixed
 * line into the "Saved memories" prompt block. Applied at BOTH enforcement sites
 * — the `save_memory`/`update_memory` tools and the dreaming pass's `capped()` —
 * so a model-authored memory and a consolidated one normalize identically and
 * can't drift.
 */
export function normalizeMemoryText(s: string): string {
	return s.trim().replace(/\s+/g, ' ');
}
