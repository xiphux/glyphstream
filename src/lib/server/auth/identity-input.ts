/**
 * Validation for the prospective-user identity (display name + email) typed at
 * the start of every onboarding flow — the first-run `/setup` wizard and the
 * invited `/join` redemption, over both GitHub OAuth and passkeys. All four
 * start/options endpoints share these exact rules, so they live here rather than
 * being copy-pasted (with their magic length caps) per route.
 */
import { error } from '@sveltejs/kit';

const MAX_DISPLAY_NAME = 60;
const MAX_EMAIL = 120;

export interface ProspectiveIdentity {
	displayName: string;
	/** Trimmed email, or null when blank — the shape the carry payload + user row want. */
	email: string | null;
}

/**
 * Trim + validate the typed display name and email, throwing `error(400)` on a
 * missing or over-long value. Email is optional and normalized to null when blank.
 */
export function parseIdentityInput(body: {
	displayName?: unknown;
	email?: unknown;
}): ProspectiveIdentity {
	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : '';
	if (displayName.length === 0) throw error(400, 'Display name is required');
	if (displayName.length > MAX_DISPLAY_NAME) throw error(400, 'Display name too long');
	if (email.length > MAX_EMAIL) throw error(400, 'Email too long');
	return { displayName, email: email || null };
}
