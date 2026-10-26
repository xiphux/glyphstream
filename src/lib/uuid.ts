/**
 * `crypto.randomUUID()` with a fallback for insecure contexts.
 *
 * Browsers expose `randomUUID` only in a secure context, and a self-hosted
 * instance reached over plain http on a LAN address (`http://192.168.…`)
 * isn't one: the call throws "crypto.randomUUID is not a function", which
 * took down toasts, attachments and optimistic sends with it.
 * `getRandomValues` has no such restriction, so the fallback builds the same
 * RFC 4122 version-4 UUID from 16 random bytes.
 */
export function randomUUID(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
