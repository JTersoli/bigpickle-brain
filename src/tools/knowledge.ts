import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isTruthy, parseFrontmatter } from '../frontmatter.ts';

export interface KnowledgeNote {
	name: string;
	content: string;
}

/**
 * Loads the agency's knowledge notes: every `.md` file in the folder, in a fixed order so the
 * system prompt stays byte-identical between runs (that is what makes prompt caching work).
 * Notes with `private: true` (or `privado: true`) in their frontmatter are never loaded.
 */
export async function loadKnowledge(dir: string): Promise<KnowledgeNote[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const notes: KnowledgeNote[] = [];
	for (const fileName of names.filter((entry) => entry.endsWith('.md') && !entry.startsWith('_')).sort()) {
		const content = await readFile(path.join(dir, fileName), 'utf8');
		const { data } = parseFrontmatter(content);
		if (isTruthy(data.private) || isTruthy(data.privado)) {
			continue;
		}
		notes.push({ name: fileName.slice(0, -3), content: content.trim() });
	}
	return notes;
}

export function renderKnowledge(notes: KnowledgeNote[]): string {
	if (notes.length === 0) {
		return '<agency_knowledge>\nNo knowledge notes were provided. Do not name services or prices: mark every opportunity as "to define".\n</agency_knowledge>';
	}
	const body = notes.map((note) => `<note name="${note.name.replace(/"/g, "'")}">\n${note.content}\n</note>`).join('\n\n');
	return `<agency_knowledge>\n${body}\n</agency_knowledge>`;
}
