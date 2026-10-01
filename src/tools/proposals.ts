import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter.ts';
import { defineTool, type AgentTool } from './types.ts';

export interface ProposalEntry {
	file: string;
	client: string;
	date: string;
	language: string;
	status: string;
	currency: string;
	totalMin: number;
	totalMax: number;
	services: string;
}

/** The proposals the agency has written so far, read from the frontmatter of the notes in the proposals folder. */
export class ProposalStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = path.resolve(dir);
	}

	/** Most recent first. */
	async list(): Promise<ProposalEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return [];
		}
		const entries: ProposalEntry[] = [];
		for (const fileName of names.filter((entry) => entry.endsWith('.md'))) {
			let data: Record<string, string>;
			try {
				({ data } = parseFrontmatter(await readFile(path.join(this.dir, fileName), 'utf8')));
			} catch {
				continue;
			}
			if (data.type !== 'proposal') {
				continue;
			}
			entries.push({
				file: fileName,
				client: data.client ?? '',
				date: data.date ?? '',
				language: data.language ?? '',
				status: data.status ?? '',
				currency: data.currency ?? '',
				totalMin: Number(data.total_min) || 0,
				totalMax: Number(data.total_max) || 0,
				services: data.services ?? '',
			});
		}
		return entries.sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
	}
}

const PastProposalsInput = z.object({
	limit: z.number().int().describe('How many of the most recent proposals to list, for example 10'),
});

export function createPastProposalsTool(store: ProposalStore): AgentTool<typeof PastProposalsInput> {
	return defineTool({
		name: 'past_proposals',
		description: "Lists the agency's most recent proposals: client, date, services and the total quoted. Use it to keep prices and scope consistent with what was quoted before.",
		schema: PastProposalsInput,
		async run(input) {
			const entries = (await store.list()).slice(0, Math.max(1, Math.min(input.limit, 50)));
			if (entries.length === 0) {
				return 'No past proposals yet.';
			}
			const lines = entries.map(
				(entry) => `- ${entry.date} | ${entry.client} | ${entry.services || 'services not recorded'} | ${entry.currency} ${entry.totalMin}-${entry.totalMax} | ${entry.status}`,
			);
			return `<past_proposals count="${entries.length}">\n${lines.join('\n')}\n</past_proposals>`;
		},
	});
}
