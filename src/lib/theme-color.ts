/**
 * Sync `<meta name="theme-color">` to the active theme + scheme's surface
 * color, so an installed PWA's status bar (iOS) and the mobile browser
 * chrome (Android) match whatever theme/light-dark the user picked.
 *
 * We read the *resolved* body background (the `--color-surface` token,
 * which the browser has already computed to an rgb value) rather than the
 * raw oklch custom property — theme-color wants a concrete color, and
 * oklch support there isn't universal. Reading getComputedStyle forces a
 * style flush, so calling this right after flipping data-theme /
 * data-scheme returns the new color.
 *
 * One JS-managed meta (created on first call) rather than the static
 * media-scoped tags in app.html, so it can reflect the forced scheme +
 * per-theme palette that prefers-color-scheme media queries can't see.
 */
export function syncThemeColorMeta(): void {
	if (typeof document === 'undefined') return;
	const bg = getComputedStyle(document.body).backgroundColor;
	if (!bg) return;
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement('meta');
		meta.name = 'theme-color';
		document.head.appendChild(meta);
	}
	meta.setAttribute('content', bg);
}
