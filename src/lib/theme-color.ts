/**
 * Sync the active surface color to the two places that can't read it from CSS.
 *
 * Named for the job rather than for one of its outputs: it was
 * syncThemeColorMeta when the meta tag was the only consumer, and a function
 * whose name points at half its effects is one a later edit tidies down to
 * that half. "Surface chrome" is the two of them together — the browser's and
 * the OS's, both taking a color the page can only hand over, never delegate.
 *
 * The two places: `<meta name="theme-color">`, which tints browser chrome
 * (Safari tabs, Android) and non-iOS installed-app bars, and the
 * .status-bar-sampler element on the (auth) routes — inside (app) the mobile
 * top bar is what iOS samples, and it needs nothing from here because it takes
 * its colour from the cascade like any other row.
 *
 * Only the META needs toLegacyRgb. This used to claim the sampler needed it
 * too, on the theory that iOS would drop the oklch the stylesheet sets — the
 * theory that had the status bar coming up blurred on a cold launch. It is
 * wrong: WebKit's gate is `styleColor.isResolvedColor()`, which excludes
 * unresolved values like currentColor, not modern colour spaces (see the
 * sampler rule in app.css for what the real gates are). The sampler write is
 * kept because it is free and harmless, not because it is load-bearing.
 *
 * That last sentence is a claim worth keeping true rather than assuming. It
 * briefly wasn't: status-bar-probe read computed backgrounds with an rgb()-only
 * parser, so this inline write was the only reason the probe reported correctly
 * on (auth), and deleting it would have broken the one route group that worked.
 * The probe normalises for itself now (it imports toLegacyRgb below), so
 * nothing downstream depends on this write landing first.
 *
 * We read the *resolved* body background (the `--color-surface` token) rather
 * than the raw custom property, then normalise it to legacy `rgb()` — see
 * toLegacyRgb. Reading getComputedStyle forces a style flush, so calling this
 * right after flipping data-theme / data-scheme returns the new color.
 *
 * One JS-managed meta (created on first call) rather than the static
 * media-scoped tags in app.html, so it can reflect the forced scheme +
 * per-theme palette that prefers-color-scheme media queries can't see.
 */
/**
 * Normalise a computed CSS colour to legacy `rgb()`.
 *
 * This used to be assumed unnecessary — the docstring above claimed the
 * browser had "already computed to an rgb value". It hasn't for a while:
 * `--color-surface` is authored in oklch, and both engines now serialise a
 * non-legacy colour in its OWN space, so getComputedStyle returns the string
 * `oklch(0.15 0.012 258)` verbatim. Measured on Chromium 151 and WebKit 26.5;
 * both agree. That string then went straight into the meta tag, which is
 * precisely what the "oklch support there isn't universal" caveat existed to
 * avoid — iOS only learned oklch in 15.4, and a theme-color it can't parse is
 * ignored, dropping the status bar back to the default.
 *
 * The canvas is the conversion: assigning any colour the engine understands to
 * fillStyle and reading the painted pixel yields sRGB bytes, with no colour
 * maths of our own to drift from the stylesheet. Verified to give exactly
 * rgb(8, 11, 16) for the dark surface on both engines. Runs on mount and on
 * theme/scheme flips only, and short-circuits entirely on engines that already
 * hand back rgb().
 *
 * Exported for lib/status-bar-probe, which reads the same tokens back off the
 * same API and so hits the same oklch serialisation. It needs the conversion
 * for a second reason this one doesn't: it COMPARES two computed backgrounds
 * for equality, and the same colour reaches it in two notations — `rgb()` where
 * syncSurfaceChrome has written one inline, `oklch()` straight from the
 * stylesheet everywhere else. Unnormalised, those compare unequal.
 */
export function toLegacyRgb(value: string): string {
	if (!value || /^(rgb|#)/i.test(value)) return value;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext('2d');
		if (!ctx) return value;
		// The sentinel does double duty. Painted and read back first, it proves
		// the READBACK is honest: Firefox with privacy.resistFingerprinting
		// (default in Tor Browser) blanks getImageData to opaque white, and
		// Brave farbles the bytes. Either would otherwise be written out as a
		// confidently wrong colour — a white status bar over the dark surface,
		// which is worse than the oklch string this replaced, since an
		// unparseable theme-color is merely ignored.
		ctx.fillStyle = '#010203';
		ctx.fillRect(0, 0, 1, 1);
		const probe = ctx.getImageData(0, 0, 1, 1).data;
		if (probe[0] !== 1 || probe[1] !== 2 || probe[2] !== 3) return value;
		// Second duty: an unparseable assignment leaves fillStyle untouched, so
		// comparing against the sentinel catches a value the engine rejected
		// rather than silently painting it black.
		ctx.fillStyle = value;
		if (ctx.fillStyle === '#010203') return value;
		// Wipe the sentinel before measuring. fillRect composites source-over,
		// so painting onto the probe pixel would blend a translucent `value`
		// with #010203 and read back a === 255 — making the alpha guard below
		// unreachable and emitting an opaque colour that is neither the surface
		// nor the real composite. Measured at rgb(4, 7, 9) in Chromium and
		// rgb(5, 7, 10) in WebKit for a 50%-alpha surface, versus passing the
		// value through untouched once the canvas is cleared.
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		// A translucent surface can't be restated as opaque rgb() without
		// lying about it. Leave those for the browser to deal with.
		return a === 255 ? `rgb(${r}, ${g}, ${b})` : value;
	} catch {
		return value;
	}
}

/**
 * A computed background of `rgba(0, 0, 0, 0)` means "nothing has painted a
 * background yet", not "the surface is transparent" — a stylesheet that hasn't
 * applied, which in practice is a dev-server CSS-injection race, since the
 * production stylesheet is render-blocking.
 *
 * It has to be rejected explicitly. The `!bg` guard below doesn't catch it (the
 * string is truthy) and neither does toLegacyRgb, whose `/^(rgb|#)/` fast path
 * matches `rgba(` and hands it straight back. Writing it used to cost one bad
 * theme-color attribute that the next call overwrote; now it would also pin a
 * TRANSPARENT inline background on the sampler, which outranks the stylesheet
 * until the next theme, scheme or private flip — i.e. it would manufacture, on
 * purpose, the see-through status bar this whole mechanism exists to prevent.
 */
const isFullyTransparent = (value: string): boolean => {
	const inner = /^rgba?\(([^)]*)\)$/i.exec(value.trim())?.[1];
	if (inner === undefined) return false;
	// The ALPHA channel specifically, never "contains a zero" — an opaque
	// rgb(0, 0, 0) is a perfectly good surface (a pure-black OLED dark theme)
	// and must not be mistaken for an unpainted one. Both serialisations are
	// handled: legacy `r, g, b, a` and modern `r g b / a`.
	const alpha = inner.includes('/') ? inner.split('/')[1] : inner.split(',')[3];
	return alpha !== undefined && Number(alpha.trim()) === 0;
};

export function syncSurfaceChrome(): void {
	if (typeof document === 'undefined') return;
	const bg = toLegacyRgb(getComputedStyle(document.body).backgroundColor);
	if (!bg || isFullyTransparent(bg)) return;
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement('meta');
		meta.name = 'theme-color';
		document.head.appendChild(meta);
	}
	meta.setAttribute('content', bg);
	// The sampler is server-rendered and already carries this color from the
	// stylesheet; this restates it as resolved rgb().
	//
	// The guard is load-bearing, not defensive. The element exists ONLY on the
	// (auth) routes now — inside (app) the mobile top bar is what iOS samples,
	// and it needs nothing from here because it takes its colour from the
	// cascade — so on most of the app this query correctly finds nothing and
	// this call does only the meta above.
	const sampler = document.querySelector<HTMLElement>('.status-bar-sampler');
	if (sampler) sampler.style.backgroundColor = bg;
}
