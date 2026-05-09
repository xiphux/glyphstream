import { allowedGithubUserIdsRaw } from '../env';

let cached: Set<number> | null = null;

/**
 * Parse the ALLOWED_GITHUB_USER_IDS env var into a Set of numeric user IDs.
 *
 * Allowlist is by NUMERIC GitHub user ID, not username/email — usernames can
 * be reassigned to different humans, emails can change, but the numeric ID
 * is permanent and tied to the GitHub account that originally registered it.
 *
 * Empty / missing env var = closed (no one can log in). Fail closed on
 * misconfiguration is the right default for a self-hosted public-facing app.
 */
export function loadAllowlist(): Set<number> {
	if (cached) return cached;
	const raw = allowedGithubUserIdsRaw();
	const ids = new Set<number>();
	for (const part of raw.split(',')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const n = Number.parseInt(trimmed, 10);
		if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
			throw new Error(
				`ALLOWED_GITHUB_USER_IDS contains an invalid entry: "${trimmed}". Use numeric GitHub user IDs only.`
			);
		}
		ids.add(n);
	}
	cached = ids;
	return ids;
}

export function isAllowed(githubUserId: number): boolean {
	return loadAllowlist().has(githubUserId);
}

/** Test/dev only: discard cached parse. */
export function resetAllowlist(): void {
	cached = null;
}
