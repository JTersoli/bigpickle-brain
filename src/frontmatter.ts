/** Minimal frontmatter support: `key: value` lines between `---` fences. Enough for flags and dates. */
export interface Frontmatter {
	data: Record<string, string>;
	body: string;
}

const OPENING = /^---[ \t]*\r?\n/;
const FENCE = /^---[ \t]*(?:\r?\n|$)/m;

export function parseFrontmatter(text: string): Frontmatter {
	if (!OPENING.test(text)) {
		return { data: {}, body: text };
	}
	const start = text.indexOf('\n') + 1;
	const close = FENCE.exec(text.slice(start));
	if (!close) {
		return { data: {}, body: text };
	}
	const block = text.slice(start, start + close.index);
	const body = text.slice(start + close.index + close[0].length);
	const data: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (match) {
			data[match[1] ?? ''] = stripQuotes((match[2] ?? '').trim());
		}
	}
	return { data, body };
}

export function isTruthy(value: string | undefined): boolean {
	return value !== undefined && ['true', 'yes', 'si', 'sí', '1'].includes(value.toLowerCase());
}

/** Sets one frontmatter value, adding the key (or the whole block) when it is missing. */
export function setFrontmatterValue(text: string, key: string, value: string): string {
	if (!OPENING.test(text)) {
		return `---\n${key}: ${value}\n---\n\n${text.replace(/^\n+/, '')}`;
	}
	const start = text.indexOf('\n') + 1;
	const close = FENCE.exec(text.slice(start));
	if (!close) {
		return text;
	}
	const body = text.slice(start + close.index + close[0].length);
	const lines = text
		.slice(start, start + close.index)
		.split(/\r?\n/)
		.filter((line, index, all) => !(index === all.length - 1 && line === ''));
	const pattern = new RegExp(`^${key}\\s*:`);
	let replaced = false;
	const updated = lines.map((line) => {
		if (pattern.test(line)) {
			replaced = true;
			return `${key}: ${value}`;
		}
		return line;
	});
	if (!replaced) {
		updated.push(`${key}: ${value}`);
	}
	return `---\n${updated.join('\n')}\n---\n${body}`;
}

function stripQuotes(value: string): string {
	const double = value.startsWith('"') && value.endsWith('"');
	const single = value.startsWith("'") && value.endsWith("'");
	if (value.length >= 2 && (double || single)) {
		return value.slice(1, -1);
	}
	return value;
}
