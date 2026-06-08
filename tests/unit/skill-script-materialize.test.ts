import { describe, expect, it } from 'vitest';
import {
	buildScriptBootstrap,
	dedupeByFilename,
	materializeSkillScript,
	MAX_SCRIPT_SIBLINGS,
} from '$lib/server/skills/script-materialize';
import type { SkillStore } from '$lib/server/skills/store';
import type { RunPythonPreFile } from '$lib/server/code-interpreter/pool';

/** Minimal in-memory SkillStore. `throwOn` makes readFile throw for a path. */
function fakeStore(files: Record<string, string>, throwOn?: string): SkillStore {
	return {
		listFiles: async () => Object.keys(files),
		readFile: async (_sp: string, rel: string) => {
			if (rel === throwOn) throw new Error(`"${rel}" is too big`);
			return rel in files ? { bytes: Buffer.from(files[rel], 'utf8'), relPath: rel } : null;
		},
	} as unknown as SkillStore;
}

const BUNDLE = {
	'SKILL.md': '---\nname: x\n---',
	'scripts/extract.py': 'import helpers',
	'scripts/helpers.py': 'def go(): pass',
	'scripts/data.csv': 'a,b',
	'references/api.md': '# api',
	'top.py': 'print(1)',
};

describe('materializeSkillScript', () => {
	it('materializes only same-dir .py siblings, basenamed', async () => {
		const r = await materializeSkillScript(fakeStore(BUNDLE), 'u/x', 'scripts/extract.py');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.entryBasename).toBe('extract.py');
		const names = r.value.preFiles.map((f) => f.filename).sort();
		expect(names).toEqual(['extract.py', 'helpers.py']);
		// Excludes the data file, the other dir, and SKILL.md.
		expect(names).not.toContain('data.csv');
		expect(names).not.toContain('api.md');
		expect(names).not.toContain('SKILL.md');
		// Each pre-file carries a sha256 + bytes.
		expect(r.value.preFiles[0].sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(r.value.preFiles[0].bytes).toBeInstanceOf(Uint8Array);
	});

	it('picks only root-level .py for a root entry', async () => {
		const r = await materializeSkillScript(fakeStore(BUNDLE), 'u/x', 'top.py');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.preFiles.map((f) => f.filename)).toEqual(['top.py']);
	});

	it('errors when the entry script is absent', async () => {
		const r = await materializeSkillScript(fakeStore(BUNDLE), 'u/x', 'scripts/missing.py');
		expect(r).toMatchObject({ ok: false });
	});

	it('surfaces a read error (e.g. oversize sibling) as an error result', async () => {
		const r = await materializeSkillScript(
			fakeStore(BUNDLE, 'scripts/helpers.py'),
			'u/x',
			'scripts/extract.py',
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('helpers.py');
	});

	it('rejects a directory with more than the sibling cap of .py files', async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i <= MAX_SCRIPT_SIBLINGS; i++) many[`scripts/s${i}.py`] = 'x';
		const r = await materializeSkillScript(fakeStore(many), 'u/x', 'scripts/s0.py');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('Too many');
	});

	it('skips a sibling that was listed but vanished (readFile → null)', async () => {
		// listFiles reports gone.py, but readFile returns null for it (delete race).
		const store = {
			listFiles: async () => ['scripts/extract.py', 'scripts/helpers.py', 'scripts/gone.py'],
			readFile: async (_sp: string, rel: string) =>
				rel === 'scripts/gone.py' ? null : { bytes: Buffer.from('x', 'utf8'), relPath: rel },
		} as unknown as Parameters<typeof materializeSkillScript>[0];
		const r = await materializeSkillScript(store, 'u/x', 'scripts/extract.py');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.preFiles.map((f) => f.filename).sort()).toEqual(['extract.py', 'helpers.py']);
	});
});

describe('dedupeByFilename', () => {
	it('keeps the last occurrence (skill files win when appended last)', () => {
		const mk = (name: string, tag: string): RunPythonPreFile => ({
			filename: name,
			bytes: new Uint8Array(),
			sha256: tag,
		});
		const out = dedupeByFilename([mk('a.py', 'conv'), mk('b.py', 'conv'), mk('a.py', 'skill')]);
		expect(out).toHaveLength(2);
		expect(out.find((f) => f.filename === 'a.py')?.sha256).toBe('skill');
	});
});

describe('buildScriptBootstrap', () => {
	it('runs the entry via runpy as __main__ and base64-encodes entry + argv', () => {
		const code = buildScriptBootstrap('extract.py', ['--flag', 'v']);
		expect(code).toContain("runpy.run_path('/workspace/' + _cfg['entry'], run_name='__main__')");
		expect(code).toContain("sys.argv = [_cfg['entry'], *_cfg['args']]");
		expect(code.trimEnd().endsWith('None')).toBe(true);
		// Nothing is string-interpolated — entry + argv ride a base64 JSON blob.
		const b64 = /base64\.b64decode\('([^']+)'\)/.exec(code)![1];
		const cfg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
		expect(cfg).toEqual({ entry: 'extract.py', args: ['--flag', 'v'] });
	});

	it('handles odd filenames + empty args without injection', () => {
		const code = buildScriptBootstrap("we'ird.py", []);
		const b64 = /base64\.b64decode\('([^']+)'\)/.exec(code)![1];
		expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))).toEqual({
			entry: "we'ird.py",
			args: [],
		});
	});
});
