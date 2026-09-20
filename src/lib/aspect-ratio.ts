/**
 * Aspect-ratio helpers for the composer. Client-safe (no `$lib/server` import).
 *
 * There is deliberately NO vocabulary of ratios here. The menu is whatever the
 * selected models advertised in `ModelEntry.aspectRatios`; a `value` is an
 * opaque token this app renders and echoes back, never a fraction it
 * normalizes. The bridge leaves `21:9` unreduced because that is the name
 * people use, so reducing it here would rename it to something no one asked
 * for — and would stop it matching the value it came from.
 *
 * The one thing these functions DO with the numbers is compare them, for
 * choosing which offered shape is nearest to a remembered one.
 */

import type { AspectRatioOption, ModelEntry } from '$lib/types/api';

/**
 * `localStorage` key for the last ratio the user explicitly picked.
 *
 * Under the `glyphstream:` prefix deliberately: `client-session-state.ts` wipes
 * that whole namespace on sign-out, and this is session-scoped state by the same
 * argument every other key there is — on a shared browser it must not outlive
 * the session and greet whoever signs in next with the previous person's
 * composer settings. A "true device preference" would belong outside the prefix;
 * a remembered shape is not one.
 */
const STICKY_KEY = 'glyphstream:aspectRatio';

/**
 * `width / height` for a `W:H` value, or null when it isn't one.
 *
 * Used for drawing a glyph and for measuring distance — never for deciding
 * whether two values are "the same", which is string identity on the token.
 */
export function parseRatio(value: string): number | null {
	// Digits bounded to match the bridge's own parser, so the two agree on what
	// is a ratio at all. Without the bound a 309-digit component overflows to
	// Infinity and `Infinity / Infinity` is NaN, which slips past a falsy check
	// and reaches the glyph as a NaN-sized rect.
	const m = /^(\d{1,6}):(\d{1,6})$/.exec(value);
	if (!m) return null;
	const w = Number(m[1]);
	const h = Number(m[2]);
	if (!w || !h) return null;
	return w / h;
}

/**
 * Ratios to offer for a set of selected models: the union, in first-seen order.
 *
 * Union rather than intersection. Intersection would shrink the menu as a user
 * adds models to a comparison — and worse, it is inconsistent with what we
 * already do for a model that advertises NO ratios: that one constrains nothing
 * (it ignores whatever is sent), so letting a model with a *different* list
 * constrain everyone would mean partial support is more restrictive than no
 * support. The union is safe because each model resolves the chosen ratio
 * against its own menu upstream, snapping to its nearest rather than failing.
 */
export function offeredRatios(models: ModelEntry[]): AspectRatioOption[] {
	const seen = new Map<string, AspectRatioOption>();
	for (const model of models) {
		for (const option of model.aspectRatios ?? []) {
			if (!seen.has(option.value)) seen.set(option.value, option);
		}
	}
	return [...seen.values()];
}

/**
 * A `W:H` written in the prompt itself — "create a 9:16 poster of…".
 *
 * Returns only a ratio the selection actually OFFERS, and only an exact one: no
 * snapping. That restriction is what makes this safe rather than clever, because
 * the dangerous false positive here is a clock. "a clock showing 3:45", "meet at
 * 10:30" are well-formed `W:H` and would each snap to some real shape; against
 * an offered list they simply don't match, and nothing happens. Snapping a
 * preference the user CLICKED is honouring it; snapping one scraped out of prose
 * stacks a second guess on the first.
 *
 * First match wins. People lead with the shape ("create a 9:16 image with…") and
 * a later ratio is usually describing something inside the picture ("with a 1:1
 * inset"), so the opener is the better guess when a prompt names two.
 *
 * Residual false positives are the offered ratios that are also idioms — "a 1:1
 * scale model of a ship" is the one that will really happen. It is visible in
 * the picker and one click overrides it, which is the whole reason the detection
 * is shown rather than applied silently at send time.
 */
export function detectRatioInPrompt(text: string, options: AspectRatioOption[]): string | null {
	if (options.length === 0 || text === '') return null;
	const offered = new Set(options.map((o) => o.value));
	// `\b` is NOT sufficient here, which is the trap: it treats `.` and `:` as
	// non-word characters, so `\b\d+:\d+\b` matches happily INSIDE "16:9.5" and
	// "9:16:30". The flanks have to reject digits and both separators — but a
	// trailing `.` is only disqualifying when a digit follows it, or "make it
	// 9:16." at the end of a sentence would stop being a ratio.
	//
	// Written with a leading capture group rather than a lookbehind: lookbehind is
	// Safari 16.4+ and this ships as an iOS PWA.
	//
	// The 1-6 digit bound matches parseRatio, so the two agree on what is a ratio
	// at all — nearly. parseRatio additionally rejects a zero component, so "0:5"
	// is recognised here and unmeasurable there. Unreachable unless an upstream
	// advertises a zero-sided shape, and harmless if one did: an offered value
	// nothing can measure already fails to draw a glyph.
	//
	// A ratio preceded by a colon ("ratio:16:9") is deliberately NOT matched — it
	// is the same flank that kills "9:16:30", and there is no way to keep one
	// without the other while the separator is what distinguishes them.
	const re = /(^|[^\d.:])(\d{1,6}:\d{1,6})(?![\d:])(?!\.\d)/g;
	for (const m of text.matchAll(re)) {
		if (offered.has(m[2])) return m[2];
	}
	return null;
}

/**
 * The model name that will sit next to the shape picker in the composer row, or
 * '' when there isn't a single one.
 *
 * Lives here, beside the other things the picker's parents feed it, because both
 * composers need it and the last two derivations that escaped this file drifted
 * into byte-identical copies. A comparison selection shows a short count ("3
 * models") instead of a name, so it puts no pressure on the row and reports ''.
 */
export function soleModelLabel(models: ModelEntry[]): string {
	return models.length === 1 ? models[0].displayName : '';
}

/**
 * The one shape the selection's own defaults agree on, for LABELLING the
 * picker's "Default" entry — never for preselecting a value.
 *
 * Undefined unless every selected model reports a default AND they all report
 * the same one. Both halves matter, and the second is the subtle one: a model
 * that advertises ratios need not advertise a default, so filtering the missing
 * ones out first would read "one model has a default" as agreement and let the
 * row name a shape that applies to one branch of a fan-out and is simply
 * unknown for the others. Saying nothing is the honest answer there — Default
 * still works, it just can't promise what it resolves to.
 */
export function agreedDefault(models: ModelEntry[]): string | undefined {
	if (models.length === 0) return undefined;
	const first = models[0].aspectRatioDefault;
	if (first === undefined) return undefined;
	return models.every((m) => m.aspectRatioDefault === first) ? first : undefined;
}

/**
 * The option to show as selected, given a preference that may not be on offer.
 *
 * Snaps in log space, so 2:1 sits as far from 1:1 as 1:2 does, and ties fall to
 * declared order. This mirrors what the bridge does on the way out, and that
 * mirroring is the point: the selector must show what the user will actually
 * get, not the preference it happens to be holding. Without it, switching to a
 * model with a different menu would leave a value highlighted that no longer
 * exists in the list — or worse, display one shape and render another.
 *
 * Returns null when nothing is on offer or there's no preference to place.
 */
export function nearestOffered(
	preference: string | null,
	options: AspectRatioOption[],
): AspectRatioOption | null {
	if (options.length === 0) return null;
	if (preference === null) return null;
	const exact = options.find((o) => o.value === preference);
	if (exact) return exact;
	const want = parseRatio(preference);
	if (want === null) return null;
	let best: AspectRatioOption | null = null;
	let bestDistance = Infinity;
	for (const option of options) {
		const r = parseRatio(option.value);
		if (r === null) continue;
		const distance = Math.abs(Math.log(r) - Math.log(want));
		// Strict `<` so an equal distance keeps the earlier (declared-order) option.
		if (distance < bestDistance) {
			best = option;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Read the remembered ratio, or null for "no preference".
 *
 * An absent key IS the no-preference state, which the picker surfaces as its
 * "Default" entry — so "never picked" and "picked Default" are the same stored
 * state, deliberately. They mean the same thing on the wire (send nothing, let
 * each model use its own default), so distinguishing them would be a difference
 * with no consequence.
 *
 * `localStorage` rather than a server-side preference: this is a per-viewer
 * convenience, like a remembered tab, and it saves a write on every generation
 * plus a migration. The cost is that it doesn't follow the user to another
 * device, which for a last-used shape is a shrug.
 *
 * Every access is guarded because the accessor itself can throw — a private
 * window, blocked site data, a thumbnail capture — and the composer has to
 * render correctly without it.
 */
export function readStickyRatio(): string | null {
	try {
		const raw = localStorage.getItem(STICKY_KEY);
		if (raw === null) return null;
		if (parseRatio(raw) !== null) return raw;
		// Junk under our own key: drop it rather than re-reading it on every mount
		// and reporting "no preference" forever.
		localStorage.removeItem(STICKY_KEY);
		return null;
	} catch {
		return null;
	}
}

/**
 * Forget the remembered ratio, returning to "no preference".
 *
 * What the picker's "Default" entry does. Removing the key rather than storing a
 * sentinel keeps one representation of the state and needs no new vocabulary in
 * `readStickyRatio` — see its note.
 */
export function clearStickyRatio(): void {
	try {
		localStorage.removeItem(STICKY_KEY);
	} catch {
		// Per-viewer convenience; losing the clear costs a stale preference.
	}
}

/**
 * Remember a ratio the user explicitly picked.
 *
 * Called on the PICK, not on send. Writing what was sent would let the
 * preference drift: pick 2:3 on a model that offers it, switch to one that
 * doesn't, and the snapped 3:4 that went out would overwrite a choice the user
 * never revised. Storing only deliberate choices means the preference survives
 * until they change it, and snapping stays a display-and-transport concern.
 */
export function writeStickyRatio(value: string): void {
	try {
		localStorage.setItem(STICKY_KEY, value);
	} catch {
		// Per-viewer convenience; losing it costs a click next time.
	}
}
