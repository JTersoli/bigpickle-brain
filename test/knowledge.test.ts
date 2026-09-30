import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, setFrontmatterValue } from '../src/frontmatter.ts';
import { loadKnowledge, renderKnowledge } from '../src/tools/knowledge.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-knowledge-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('loadKnowledge', () => {
	it('loads notes in name order and skips private and underscored ones', async () => {
		await writeFile(path.join(dir, 'b prices.md'), '---\ntipo: conocimiento\n---\n\n# Prices\n', 'utf8');
		await writeFile(path.join(dir, 'a about.md'), '# About\n\nWho we are.\n', 'utf8');
		await writeFile(path.join(dir, 'c secret.md'), '---\nprivate: true\n---\n\nnever\n', 'utf8');
		await writeFile(path.join(dir, 'd secreto.md'), '---\nprivado: sí\n---\n\nnunca\n', 'utf8');
		await writeFile(path.join(dir, '_draft.md'), 'draft\n', 'utf8');
		await writeFile(path.join(dir, 'notes.txt'), 'not markdown\n', 'utf8');

		const notes = await loadKnowledge(dir);
		expect(notes.map((note) => note.name)).toEqual(['a about', 'b prices']);
		expect(notes[0]?.content).toBe('# About\n\nWho we are.');

		const rendered = renderKnowledge(notes);
		expect(rendered.startsWith('<agency_knowledge>\n<note name="a about">\n# About')).toBe(true);
		expect(rendered).toContain('<note name="b prices">');
		expect(rendered).not.toContain('never');
		expect(rendered).not.toContain('nunca');
		expect(rendered).not.toContain('draft');
	});

	it('returns nothing for a missing folder and says so in the prompt', async () => {
		expect(await loadKnowledge(path.join(dir, 'missing'))).toEqual([]);
		expect(renderKnowledge([])).toContain('No knowledge notes were provided');
	});
});

describe('frontmatter', () => {
	it('parses simple key: value blocks', () => {
		const parsed = parseFrontmatter('---\ntype: client\nname: "Gina\'s"\nupdated: 2026-09-30\n---\n\n# Gina\n');
		expect(parsed.data).toEqual({ type: 'client', name: "Gina's", updated: '2026-09-30' });
		expect(parsed.body).toBe('\n# Gina\n');
		expect(parseFrontmatter('# No frontmatter\n')).toEqual({ data: {}, body: '# No frontmatter\n' });
		expect(parseFrontmatter('---\nunclosed: yes\n')).toEqual({ data: {}, body: '---\nunclosed: yes\n' });
	});

	it('replaces or adds a value, and creates the block when missing', () => {
		expect(setFrontmatterValue('---\nupdated: 2026-01-01\n---\n\nbody\n', 'updated', '2026-09-30')).toBe('---\nupdated: 2026-09-30\n---\n\nbody\n');
		expect(setFrontmatterValue('---\ntype: client\n---\nbody\n', 'updated', '2026-09-30')).toBe('---\ntype: client\nupdated: 2026-09-30\n---\nbody\n');
		expect(setFrontmatterValue('# Title\n', 'updated', '2026-09-30')).toBe('---\nupdated: 2026-09-30\n---\n\n# Title\n');
	});
});
