/**
 * Sync `<meta name="theme-color">` to the active theme + scheme's surface
 * color, so an installed PWA's status bar (iOS) and the mobile browser
 * chrome (Android) match whatever theme/light-dark the user picked.
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
 */
function toLegacyRgb(value: string): string {
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
		// Brave farbles the bytes. Either would sail past the alpha check below
		// and write a confidently wrong colour — a white status bar over the
		// dark surface, which is worse than the oklch string this replaced,
		// since an unparseable theme-color is merely ignored.
		ctx.fillStyle = '#010203';
		ctx.fillRect(0, 0, 1, 1);
		const probe = ctx.getImageData(0, 0, 1, 1).data;
		if (probe[0] !== 1 || probe[1] !== 2 || probe[2] !== 3) return value;
		// Second duty: an unparseable assignment leaves fillStyle untouched, so
		// comparing against the sentinel catches a value the engine rejected
		// rather than silently painting it black.
		ctx.fillStyle = value;
		if (ctx.fillStyle === '#010203') return value;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		// A translucent surface can't be restated as opaque rgb() without
		// lying about it. Leave those for the browser to deal with.
		return a === 255 ? `rgb(${r}, ${g}, ${b})` : value;
	} catch {
		return value;
	}
}

export function syncThemeColorMeta(): void {
	if (typeof document === 'undefined') return;
	const bg = toLegacyRgb(getComputedStyle(document.body).backgroundColor);
	if (!bg) return;
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement('meta');
		meta.name = 'theme-color';
		document.head.appendChild(meta);
	}
	meta.setAttribute('content', bg);
}
