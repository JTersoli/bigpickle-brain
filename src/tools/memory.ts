import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter, setFrontmatterValue } from '../frontmatter.ts';
import { defineTool, type AgentTool } from './types.ts';

export interface ClientEntry {
	slug: string;
	name: string;
	file: string;
}

/** One Markdown note per client, append-only. Agents add dated lines; people edit in Obsidian or any editor. */
export class ClientMemory {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = path.resolve(dir);
	}

	static slug(name: string): string {
		const slug = name
			.normalize('NFD')
			.replace(/\p{M}+/gu, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return slug || 'client';
	}

	/** The note path for a client name. Refuses anything that would leave the memory folder. */
	pathFor(name: string): string {
		const file = path.resolve(this.dir, `${ClientMemory.slug(name)}.md`);
		const relative = path.relative(this.dir, file);
		if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
			throw new Error(`Refusing to touch a file outside the memory folder: ${file}`);
		}
		return file;
	}

	async list(): Promise<ClientEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return [];
		}
		const entries: ClientEntry[] = [];
		for (const fileName of names.filter((entry) => entry.endsWith('.md')).sort()) {
			const file = path.join(this.dir, fileName);
			const slug = fileName.slice(0, -3);
			let name = slug;
			try {
				const { data, body } = parseFrontmatter(await readFile(file, 'utf8'));
				name = data.name || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slug;
			} catch {
				// An unreadable note still counts as a known client.
			}
			entries.push({ slug, name, file });
		}
		return entries;
	}

	async read(name: string): Promise<string | null> {
		try {
			return await readFile(this.pathFor(name), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
	}

	/** Appends dated lines to the client's note, creating it when needed. Returns the note path. */
	async append(name: string, entries: string[], source: string, date: Date = new Date()): Promise<string> {
		const file = this.pathFor(name);
		const today = isoDate(date);
		let text = (await this.read(name)) ?? template(name.trim(), today);
		text = setFrontmatterValue(text, 'updated', today);
		const lines = entries
			.map(oneLine)
			.filter(Boolean)
			.map((entry) => `- ${today} (${source}): ${entry}`);
		if (lines.length === 0) {
			return file;
		}
		text = `${text.trimEnd()}\n${lines.join('\n')}\n`;
		await mkdir(this.dir, { recursive: true });
		await writeFile(file, text, 'utf8');
		return file;
	}
}

function template(name: string, today: string): string {
	return ['---', 'type: client', `name: "${name.replace(/"/g, "'")}"`, `created: ${today}`, `updated: ${today}`, '---', '', `# ${name}`, '', '## Notes', ''].join('\n');
}

export function isoDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '').trim();
}

const RecallInput = z.object({
	name: z.string().describe('The business name'),
});

const RememberInput = z.object({
	name: z.string().describe('The business name'),
	facts: z.array(z.string()).describe('Verified facts worth keeping, one sentence each'),
});

export function createMemoryTools(memory: ClientMemory, now: () => Date = () => new Date()): AgentTool[] {
	const recall = defineTool({
		name: 'recall_client',
		description: "Reads the agency's notes about a business from earlier work, or lists the businesses it has notes about.",
		schema: RecallInput,
		async run(input) {
			const note = await memory.read(input.name);
			if (note !== null) {
				return `<client_memory name="${input.name.replace(/"/g, "'")}">\n${note.trim()}\n</client_memory>`;
			}
			const known = await memory.list();
			const list = known.length > 0 ? known.map((entry) => entry.name).join(', ') : 'none yet';
			return `No notes about "${input.name}". Businesses with notes: ${list}.`;
		},
	});

	const remember = defineTool({
		name: 'remember_client',
		description: "Saves verified facts about a business to the agency's notes, so the next agent or person starts from them. Facts only, not guesses.",
		schema: RememberInput,
		async run(input) {
			const file = await memory.append(input.name, input.facts, 'agent', now());
			return `Saved ${input.facts.length} fact(s) to ${path.basename(file)}.`;
		},
	});

	return [recall, remember];
}
