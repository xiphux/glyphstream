/**
 * Minimal SSE (Server-Sent Events) wire-format parser.
 *
 * OpenAI-shaped chat-completions streams use only `data:` lines plus a
 * `data: [DONE]` sentinel. We honor optional `event:` lines too so this
 * parser can be reused if/when an upstream emits typed events.
 *
 * Returns an async iterable of `{event, data}` records, one per SSE block
 * (records are separated by blank lines per RFC). Multi-line `data:` is
 * concatenated with newlines per the spec.
 */
export interface SSERecord {
	event: string;
	data: string;
}

export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<SSERecord> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.length > 0) {
					const rec = parseBlock(buffer);
					if (rec) yield rec;
				}
				return;
			}

			buffer += decoder.decode(value, { stream: true });

			// SSE blocks are separated by a blank line. Accept both LF/LF and CRLF/CRLF.
			let sepIdx: number;
			while ((sepIdx = findBlockSeparator(buffer)) !== -1) {
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

function findBlockSeparator(buf: string): number {
	const a = buf.indexOf('\n\n');
	const b = buf.indexOf('\r\n\r\n');
	if (a === -1) return b;
	if (b === -1) return a;
	return Math.min(a, b);
}

function parseBlock(block: string): SSERecord | null {
	let event = 'message';
	const dataLines: string[] = [];
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line || line.startsWith(':')) continue; // comments + blanks ignored
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
			// id/retry intentionally ignored — we don't reconnect SSE.
		}
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join('\n') };
}
