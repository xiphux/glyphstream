/**
 * Server entrypoint for the shared SSE parser. The implementation lives in
 * `$lib/sse-parse` — isomorphic, so the browser stream reader imports the same
 * code — and this re-export keeps the server-only import path stable for the
 * relay and the upstream normalizers.
 */
export { parseSSEStream, SSEBufferOverflowError } from '$lib/sse-parse';
export type { SSERecord } from '$lib/sse-parse';
