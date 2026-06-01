/**
 * Client-side conversation mutations shared by the sidebar and the
 * archived list. Each owns the fetch plus the `!res.ok && status !== 404`
 * check — a 404 means the conversation is already gone, which is success
 * for an archive/delete. Callers keep their own busy-state, toast,
 * navigation and Undo orchestration.
 */

import { errorMessageFromResponse } from '$lib/fetch-error';

/** Archive or unarchive a conversation. */
export async function setArchived(id: string, archived: boolean): Promise<void> {
	const res = await fetch(`/api/conversations/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ archived }),
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(`Server returned ${res.status}`);
	}
}

/**
 * Permanently delete a conversation. When `deleteMedia` is true, generated
 * images/videos that would orphan are purged from the gallery alongside it.
 */
export async function deleteConversation(id: string, deleteMedia: boolean): Promise<void> {
	const url = deleteMedia
		? `/api/conversations/${id}?deleteMedia=true`
		: `/api/conversations/${id}`;
	const res = await fetch(url, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) {
		throw new Error(`Server returned ${res.status}`);
	}
}

/**
 * Rename a conversation. Unlike archive/delete this reads the server's
 * error body (via errorMessageFromResponse) because a rename can fail
 * for validation reasons — empty title, max length, etc — and the user
 * benefits from seeing the specific message.
 */
export async function renameConversation(id: string, title: string): Promise<void> {
	const res = await fetch(`/api/conversations/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) {
		throw new Error(await errorMessageFromResponse(res));
	}
}
