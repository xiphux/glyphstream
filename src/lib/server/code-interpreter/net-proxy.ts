/**
 * Network egress for the code interpreter, performed by the HOST on the
 * interpreter's behalf.
 *
 * The interpreter runs in a child process started under Node's permission
 * model with no network grant (see spawn.ts), so it cannot open a socket of
 * any kind — Pyodide's own Node socket transport included. Its `fetch` is a
 * shim that ships the request here over IPC; this module applies the whole
 * policy and performs the request. Keeping the policy on this side of the
 * boundary means nothing the model's Python can reach decides what is
 * allowed.
 *
 * Policy, re-checked on every redirect hop:
 *   1. the conversation's `web` toggle (off → refuse everything),
 *   2. http(s) only,
 *   3. not a configured backend host (upstream LLM / search endpoint),
 *   4. the hostname must resolve to a publicly routable address, checked
 *      again at connect time so DNS rebinding can't swap it.
 *
 * Deliberately free of SvelteKit / config imports: the caller passes the
 * forbidden-host set, so the real-Pyodide integration test can drive it.
 */

import {
	assertHostnameRoutable,
	assertHttpScheme,
	normalizeHostname,
	fetchRoutable,
	UrlPolicyError,
} from '../tools/url-policy-base';

export interface ProxyFetchRequest {
	url: string;
	method: string;
	headers: Array<[string, string]>;
	body: Uint8Array<ArrayBuffer> | null;
}

export interface ProxyFetchResponse {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	body: Uint8Array<ArrayBuffer>;
	url: string;
}

export interface ProxyPolicy {
	/** The conversation has its `web` feature category turned off. */
	webDisabled: boolean;
	/** Lowercased hostnames of configured backends. */
	forbiddenHosts: ReadonlySet<string>;
	/** Aborts the request (the run_python call ended, or the worker died). */
	signal?: AbortSignal;
}

const MAX_REDIRECTS = 3;
/** Same ceiling as a run's aggregate file budget; big enough for the
 *  pure-Python wheels micropip installs, small enough to bound the copy
 *  across the IPC channel. */
export const MAX_PROXY_RESPONSE_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

/** Headers that describe the wire encoding of a body we have already
 *  decoded; forwarding them would make the interpreter's `Response`
 *  describe bytes it doesn't have. */
const DROPPED_RESPONSE_HEADERS = new Set([
	'content-encoding',
	'content-length',
	'transfer-encoding',
]);

export async function proxyInterpreterFetch(
	req: ProxyFetchRequest,
	policy: ProxyPolicy,
): Promise<ProxyFetchResponse> {
	let current: URL;
	try {
		current = new URL(req.url);
	} catch {
		throw new UrlPolicyError(`Refused: "${req.url}" is not a valid URL.`);
	}

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = policy.signal ? AbortSignal.any([policy.signal, timeout]) : timeout;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (policy.webDisabled) {
			throw new UrlPolicyError(
				'Refused: web access is disabled for this conversation; Python network calls (including pyfetch / micropip) are blocked.',
			);
		}
		assertHttpScheme(current);
		const host = normalizeHostname(current.hostname);
		if (policy.forbiddenHosts.has(host)) {
			throw new UrlPolicyError(
				`Refused: ${host} is a configured backend (an upstream LLM or search endpoint); the model is not allowed to reach it through tool calls.`,
			);
		}
		await assertHostnameRoutable(current.hostname);

		// `redirect: 'manual'` so the policy re-runs on every hop. The body is
		// only sent on the first hop; replaying it across redirects is its own
		// can of worms and a 307/308 that needs it is rare from model code.
		const res = await fetchRoutable(current, {
			method: req.method,
			headers: req.headers,
			body: hop === 0 && req.body ? req.body : undefined,
			redirect: 'manual',
			signal,
		});

		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			await res.body?.cancel().catch(() => {});
			if (!loc) {
				throw new UrlPolicyError(
					`HTTP ${res.status} redirect from ${current.hostname} without a Location header.`,
				);
			}
			if (hop >= MAX_REDIRECTS) {
				throw new UrlPolicyError(`Refused: exceeded ${MAX_REDIRECTS} redirects.`);
			}
			try {
				current = new URL(loc, current);
			} catch {
				throw new UrlPolicyError(`Redirect Location "${loc}" is not a valid URL.`);
			}
			continue;
		}

		const body = await readCapped(res, MAX_PROXY_RESPONSE_BYTES);
		const headers: Array<[string, string]> = [];
		res.headers.forEach((value, key) => {
			if (!DROPPED_RESPONSE_HEADERS.has(key)) headers.push([key, value]);
		});
		return {
			status: res.status,
			statusText: res.statusText,
			headers,
			body,
			url: current.href,
		};
	}
	throw new UrlPolicyError(`Refused: exceeded ${MAX_REDIRECTS} redirects.`);
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel().catch(() => {});
			throw new UrlPolicyError(`Refused: response larger than ${cap} bytes.`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}
