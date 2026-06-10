/**
 * Browser SSE reader. A thin alias over the shared `$lib/sse-parse`
 * implementation — the same parser the server relay uses. EventSource only
 * does GET; we POST to `/api/conversations/:id/messages?stream=1` and read the
 * streamed body ourselves, yielding the parsed `{ event, data }` record per
 * SSE block. Callers JSON.parse the data and dispatch by event name.
 */
export { parseSSEStream as readSSE } from '$lib/sse-parse';
export type { SSERecord as SSEEventRecord } from '$lib/sse-parse';
