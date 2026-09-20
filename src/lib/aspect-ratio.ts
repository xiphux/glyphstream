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
 * Read the remembered ratio.
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
