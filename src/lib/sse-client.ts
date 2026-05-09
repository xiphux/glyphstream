/**
 * Minimal SSE-over-fetch reader. EventSource only does GET; we POST to
 * `/api/conversations/:id/messages?stream=1` and read the streamed body.
 *
 * Yields the parsed { event, data } record per SSE block. Caller is
 * responsible for JSON.parse'ing data + dispatching by event name.
 */
export interface SSEEventRecord {
	event: string;
	data: string;
}

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<SSEEventRecord> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim().length > 0) {
					const rec = parseBlock(buffer);
					if (rec) yield rec;
				}
				return;
			}
			buffer += decoder.decode(value, { stream: true });

			let sepIdx: number;
			while ((sepIdx = findSep(buffer)) !== -1) {
				const block = buffer.slice(0, sepIdx);
				buffer = buffer.slice(sepIdx).replace(/^(\r?\n){2}/, '');
				const rec = parseBlock(block);
				if (rec) yield rec;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function findSep(buf: string): number {
	const a = buf.indexOf('\n\n');
	const b = buf.indexOf('\r\n\r\n');
	if (a === -1) return b;
	if (b === -1) return a;
	return Math.min(a, b);
}

function parseBlock(block: string): SSEEventRecord | null {
	let event = 'message';
	const dataLines: string[] = [];
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
		switch (field) {
			case 'event':
				event = value;
				break;
			case 'data':
				dataLines.push(value);
				break;
		}
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join('\n') };
}
