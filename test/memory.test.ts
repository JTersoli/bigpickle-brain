import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientMemory, createMemoryTools } from '../src/tools/memory.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('ClientMemory', () => {
	it('turns names into safe slugs', () => {
		expect(ClientMemory.slug("Gina's Bakery, Bondi!")).toBe('gina-s-bakery-bondi');
		expect(ClientMemory.slug('Café Ñandú')).toBe('cafe-nandu');
		expect(ClientMemory.slug('../../etc/passwd')).toBe('etc-passwd');
		expect(ClientMemory.slug('***')).toBe('client');
	});

	it('keeps every note inside the folder', () => {
		const memory = new ClientMemory(dir);
		expect(memory.pathFor('../../x')).toBe(path.join(dir, 'x.md'));
		expect(memory.pathFor('C:\\Windows\\system32')).toBe(path.join(dir, 'c-windows-system32.md'));
	});

	it('creates a note on the first append and adds dated lines after', async () => {
		const memory = new ClientMemory(dir);
		const file = await memory.append("Gina's Bakery", ['Sells sourdough', '  - No website  ', '   '], 'research', new Date(2026, 8, 30));
		const text = await readFile(file, 'utf8');
		expect(text).toMatch(/^---\ntype: client\nname: "Gina's Bakery"\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n/);
		expect(text).toContain("# Gina's Bakery");
		expect(text).toContain('## Notes');
		expect(text).toContain('- 2026-09-30 (research): Sells sourdough');
		expect(text).toContain('- 2026-09-30 (research): No website');
		expect(text.endsWith('\n')).toBe(true);

		await memory.append("gina's bakery", ['Opened in 2019'], 'agent', new Date(2026, 9, 2));
		const again = await readFile(file, 'utf8');
		expect(again).toContain('created: 2026-09-30');
		expect(again).toContain('updated: 2026-10-02');
		expect(again).toContain('- 2026-10-02 (agent): Opened in 2019');
		expect(again.match(/^# /gm)).toHaveLength(1);
		expect(again.match(/^---$/gm)).toHaveLength(2);
	});

	it('lists clients by name and reads missing notes as null', async () => {
		const memory = new ClientMemory(dir);
		expect(await memory.list()).toEqual([]);
		expect(await memory.read('Nobody')).toBeNull();
		await memory.append('Zeta Bar', ['x'], 'agent');
		await memory.append('Alpha Café', ['y'], 'agent');
		const names = (await memory.list()).map((entry) => entry.name);
		expect(names).toEqual(['Alpha Café', 'Zeta Bar']);
		expect(await memory.read('alpha cafe')).toContain('# Alpha Café');
	});
});

describe('memory tools', () => {
	const context = { log: () => undefined };

	it('recall returns the note or the known clients, remember appends', async () => {
		const [recall, remember] = createMemoryTools(new ClientMemory(dir));
		expect(await recall!.run({ name: 'Nobody' }, context)).toContain('none yet');

		expect(await remember!.run({ name: 'Nobody', facts: ['Fact one', 'Fact two'] }, context)).toBe('Saved 2 fact(s) to nobody.md.');

		const note = await recall!.run({ name: 'Nobody' }, context);
		expect(note).toContain('<client_memory name="Nobody">');
		expect(note).toContain('(agent): Fact one');
		expect(note.endsWith('</client_memory>')).toBe(true);

		expect(await recall!.run({ name: 'Other' }, context)).toBe('No notes about "Other". Businesses with notes: Nobody.');
	});
});
