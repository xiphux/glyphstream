/**
 * Single canonical ID generator for DB row keys (conversations,
 * messages, memories, custom models, push subscriptions, users, media,
 * import-time conversation ids).
 *
 * Centralized so the same source can be swapped in one place — for
 * example, mocked in tests that need deterministic ids, or replaced
 * with a sortable id format later (UUIDv7) without touching every
 * query module. Returns a standard UUID v4 today.
 *
 * The disk-store's media filename derivation uses a dashes-stripped
 * variant and stays on the direct `randomUUID().replace(...)` call —
 * it's a path component, not a row key.
 */

import { randomUUID } from 'node:crypto';

export function generateId(): string {
	return randomUUID();
}
