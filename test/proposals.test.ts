import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPastProposalsTool, ProposalStore } from '../src/tools/proposals.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-proposals-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const note = (client: string, date: string, total: [number, number], services: string) =>
	`---\ntype: proposal\nclient: "${client}"\ndate: ${date}\nlanguage: es\nstatus: draft\ncurrency: AUD\ntotal_min: ${total[0]}\ntotal_max: ${total[1]}\nservices: "${services}"\n---\n\n# ${client}\n`;

describe('ProposalStore', () => {
	it('lists proposals from frontmatter, newest first, and skips other notes', async () => {
		await writeFile(path.join(dir, 'a.md'), note('Alpha Café', '2026-09-20', [500, 600], 'Landing page'), 'utf8');
		await writeFile(path.join(dir, 'b.md'), note('Beta Bar', '2026-10-01', [1000, 1500], 'Sitio web de hasta 5 páginas'), 'utf8');
		await writeFile(path.join(dir, 'c.md'), '---\ntype: research\nclient: "Gamma"\n---\n', 'utf8');
		await writeFile(path.join(dir, 'd.txt'), 'not a note', 'utf8');

		const entries = await new ProposalStore(dir).list();
		expect(entries.map((entry) => entry.client)).toEqual(['Beta Bar', 'Alpha Café']);
		expect(entries[0]).toMatchObject({ file: 'b.md', date: '2026-10-01', totalMin: 1000, totalMax: 1500, currency: 'AUD', status: 'draft', services: 'Sitio web de hasta 5 páginas' });
	});

	it('returns nothing for a missing folder', async () => {
		expect(await new ProposalStore(path.join(dir, 'missing')).list()).toEqual([]);
	});
});

describe('past_proposals tool', () => {
	const context = { log: () => undefined };

	it('lists the most recent proposals or says there are none', async () => {
		const tool = createPastProposalsTool(new ProposalStore(dir));
		expect(await tool.run({ limit: 5 }, context)).toBe('No past proposals yet.');

		await writeFile(path.join(dir, 'a.md'), note('Alpha Café', '2026-09-20', [500, 600], 'Landing page'), 'utf8');
		await writeFile(path.join(dir, 'b.md'), note('Beta Bar', '2026-10-01', [1000, 1500], 'Sitio web de hasta 5 páginas'), 'utf8');
		const text = await tool.run({ limit: 1 }, context);
		expect(text).toBe('<past_proposals count="1">\n- 2026-10-01 | Beta Bar | Sitio web de hasta 5 páginas | AUD 1000-1500 | draft\n</past_proposals>');
	});
});
