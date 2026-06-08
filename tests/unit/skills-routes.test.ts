/**
 * Route-handler tests for the skills HTTP surface. The orchestration
 * (importSkillBundle) and query layer have their own tests — this pins the
 * thin marshalling the routes own: content-type branching, the multipart
 * body-size → 413 guard, 415/400 rejections, auth gating, and the PATCH/DELETE
 * validation + 404s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, type HttpError } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	importSkillBundle: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
	listSkillsForUser: vi.fn<(...a: unknown[]) => unknown>(),
	setSkillEnabled: vi.fn<(...a: unknown[]) => unknown>(),
	deleteSkill: vi.fn<(...a: unknown[]) => unknown>(),
	deleteBundle: vi.fn<(...a: unknown[]) => Promise<void>>(),
}));

vi.mock('$lib/server/skills/import-skill', () => ({
	importSkillBundle: (...a: unknown[]) => mocks.importSkillBundle(...a),
}));
vi.mock('$lib/server/db/queries/skills', () => ({
	listSkillsForUser: (...a: unknown[]) => mocks.listSkillsForUser(...a),
	setSkillEnabled: (...a: unknown[]) => mocks.setSkillEnabled(...a),
	deleteSkill: (...a: unknown[]) => mocks.deleteSkill(...a),
}));
vi.mock('$lib/server/skills/disk-store', () => ({
	getSkillStore: () => ({ deleteBundle: (...a: unknown[]) => mocks.deleteBundle(...a) }),
}));

import { GET, POST } from '../../src/routes/api/user/skills/+server';
import { PATCH, DELETE } from '../../src/routes/api/user/skills/[id]/+server';

type Locals = { user: { id: string } | null };
const userLocals: Locals = { user: { id: 'u1' } };
const anonLocals: Locals = { user: null };

function req(contentType: string, impl: Partial<Pick<Request, 'json' | 'formData'>>): Request {
	return { headers: { get: () => contentType }, ...impl } as unknown as Request;
}

async function expectHttpError(fn: () => unknown): Promise<HttpError> {
	try {
		await (async () => fn())();
	} catch (e) {
		if (isHttpError(e)) return e;
		throw e;
	}
	throw new Error('expected an HttpError, none thrown');
}

beforeEach(() => {
	mocks.importSkillBundle.mockReset();
	mocks.listSkillsForUser.mockReset();
	mocks.setSkillEnabled.mockReset();
	mocks.deleteSkill.mockReset();
	mocks.deleteBundle.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/user/skills', () => {
	it('returns the caller’s skills', async () => {
		mocks.listSkillsForUser.mockReturnValue([{ id: 's1', name: 'review' }]);
		const res = (await GET({ locals: userLocals } as never)) as Response;
		expect(mocks.listSkillsForUser).toHaveBeenCalledWith('u1');
		expect(await res.json()).toEqual({ skills: [{ id: 's1', name: 'review' }] });
	});

	it('401s without a user', async () => {
		const e = await expectHttpError(() => GET({ locals: anonLocals } as never));
		expect(e.status).toBe(401);
	});
});

describe('POST /api/user/skills', () => {
	const call = (locals: Locals, request: Request) => POST({ locals, request } as never);

	it('imports a pasted SKILL.md (application/json)', async () => {
		mocks.importSkillBundle.mockResolvedValue({ ok: true, skill: { id: 's1', name: 'review' } });
		const res = (await call(
			userLocals,
			req('application/json', { json: async () => ({ content: 'SKILL BODY' }) }),
		)) as Response;
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ skill: { id: 's1', name: 'review' } });
		const [userId, files] = mocks.importSkillBundle.mock.calls[0] as [
			string,
			{ relPath: string; bytes: Buffer }[],
		];
		expect(userId).toBe('u1');
		expect(files).toHaveLength(1);
		expect(files[0].relPath).toBe('SKILL.md');
		expect(files[0].bytes.toString('utf8')).toBe('SKILL BODY');
	});

	it('400s on empty/non-string json content', async () => {
		const e = await expectHttpError(() =>
			call(userLocals, req('application/json', { json: async () => ({ content: '   ' }) })),
		);
		expect(e.status).toBe(400);
		expect(mocks.importSkillBundle).not.toHaveBeenCalled();
	});

	it('marshals multipart files (relPath from the part filename)', async () => {
		mocks.importSkillBundle.mockResolvedValue({ ok: true, skill: { id: 's2', name: 'x' } });
		const fd = new FormData();
		fd.append('file', new File([Buffer.from('---\nname: x\n---\nb')], 'my-skill/SKILL.md'));
		fd.append('file', new File([Buffer.from('# api')], 'my-skill/references/api.md'));
		const res = (await call(
			userLocals,
			req('multipart/form-data', { formData: async () => fd }),
		)) as Response;
		expect(res.status).toBe(201);
		const [, files] = mocks.importSkillBundle.mock.calls[0] as [string, { relPath: string }[]];
		expect(files.map((f) => f.relPath)).toEqual([
			'my-skill/SKILL.md',
			'my-skill/references/api.md',
		]);
	});

	it('400s when the multipart body has no file parts', async () => {
		const e = await expectHttpError(() =>
			call(userLocals, req('multipart/form-data', { formData: async () => new FormData() })),
		);
		expect(e.status).toBe(400);
	});

	it('413s when formData() fails on a body-size overflow', async () => {
		const e = await expectHttpError(() =>
			call(
				userLocals,
				req('multipart/form-data', {
					formData: async () => {
						throw new Error('Content-Length exceeded BODY_SIZE_LIMIT (body too large)');
					},
				}),
			),
		);
		expect(e.status).toBe(413);
		expect(mocks.importSkillBundle).not.toHaveBeenCalled();
	});

	it('400s when formData() fails for an unrelated parse reason', async () => {
		const e = await expectHttpError(() =>
			call(
				userLocals,
				req('multipart/form-data', {
					formData: async () => {
						throw new Error('malformed multipart boundary');
					},
				}),
			),
		);
		expect(e.status).toBe(400);
	});

	it('415s on an unsupported content type', async () => {
		const e = await expectHttpError(() => call(userLocals, req('text/plain', {})));
		expect(e.status).toBe(415);
	});

	it('propagates importSkillBundle’s failure status (e.g. duplicate 409)', async () => {
		mocks.importSkillBundle.mockResolvedValue({ ok: false, status: 409, error: 'dup' });
		const e = await expectHttpError(() =>
			call(userLocals, req('application/json', { json: async () => ({ content: 'x' }) })),
		);
		expect(e.status).toBe(409);
	});

	it('401s without a user', async () => {
		const e = await expectHttpError(() =>
			call(anonLocals, req('application/json', { json: async () => ({ content: 'x' }) })),
		);
		expect(e.status).toBe(401);
	});
});

describe('PATCH /api/user/skills/:id', () => {
	const call = (locals: Locals, id: string, enabled: unknown) =>
		PATCH({
			locals,
			params: { id },
			request: req('application/json', { json: async () => ({ enabled }) }),
		} as never);

	it('toggles enabled and returns ok', async () => {
		mocks.setSkillEnabled.mockReturnValue(true);
		const res = (await call(userLocals, 's1', false)) as Response;
		expect(mocks.setSkillEnabled).toHaveBeenCalledWith('u1', 's1', false);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('400s on a non-boolean enabled', async () => {
		const e = await expectHttpError(() => call(userLocals, 's1', 'yes'));
		expect(e.status).toBe(400);
		expect(mocks.setSkillEnabled).not.toHaveBeenCalled();
	});

	it('404s when no row matches the caller', async () => {
		mocks.setSkillEnabled.mockReturnValue(false);
		const e = await expectHttpError(() => call(userLocals, 'ghost', true));
		expect(e.status).toBe(404);
	});
});

describe('DELETE /api/user/skills/:id', () => {
	const call = (locals: Locals, id: string) => DELETE({ locals, params: { id } } as never);

	it('deletes the row then the bundle and returns 204', async () => {
		mocks.deleteSkill.mockReturnValue({ storagePath: 'u1/review' });
		const res = (await call(userLocals, 's1')) as Response;
		expect(res.status).toBe(204);
		expect(mocks.deleteSkill).toHaveBeenCalledWith('u1', 's1');
		expect(mocks.deleteBundle).toHaveBeenCalledWith('u1/review');
	});

	it('404s without touching the store when no row matches', async () => {
		mocks.deleteSkill.mockReturnValue(null);
		const e = await expectHttpError(() => call(userLocals, 'ghost'));
		expect(e.status).toBe(404);
		expect(mocks.deleteBundle).not.toHaveBeenCalled();
	});
});
