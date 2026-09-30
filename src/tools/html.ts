/** HTML to readable text: headings, lists, links with their URLs, no scripts or styles. */
export interface PageText {
	title: string;
	description: string;
	text: string;
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	copy: '©',
	reg: '®',
	trade: '™',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	eacute: 'é',
	aacute: 'á',
	iacute: 'í',
	oacute: 'ó',
	uacute: 'ú',
	ntilde: 'ñ',
	uuml: 'ü',
};

export function htmlToText(html: string, baseUrl?: string): PageText {
	let s = html.replace(/\r\n?/g, '\n');
	const title = collapse(decodeEntities(stripTags(first(s, /<title[^>]*>([\s\S]*?)<\/title>/i))));
	const description = collapse(
		decodeEntities(
			first(s, /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i) ||
				first(s, /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i),
		),
	);

	s = s.replace(/<!--[\s\S]*?-->/g, ' ');
	s = s.replace(/<(script|style|noscript|svg|template|iframe|head|canvas|video|audio|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
	s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
	s = s.replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `);
	s = s.replace(/<\/h[1-6]\s*>/gi, '\n\n');
	s = s.replace(/<li\b[^>]*>/gi, '\n- ');
	s = s.replace(/<(p|div|tr|section|article|header|footer|nav|blockquote|table|ul|ol|main|aside|pre|form|figure|dl|address)\b[^>]*>/gi, '\n');
	s = s.replace(/<\/(p|div|li|tr|section|article|header|footer|nav|blockquote|table|ul|ol|main|aside|pre|form|figure|figcaption|dl|dd|dt|address|fieldset)\s*>/gi, '\n');
	s = s.replace(/<\/(td|th)\s*>/gi, ' | ');
	s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, href: string, inner: string) => {
		const label = collapse(decodeEntities(stripTags(inner)));
		const url = resolveHref(decodeEntities(href), baseUrl);
		if (!label) {
			return url ? ` ${url} ` : ' ';
		}
		return url ? ` [${label}](${url}) ` : ` ${label} `;
	});
	s = s.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, (_match, alt: string) => (alt.trim() ? ` [image: ${collapse(alt)}] ` : ' '));
	s = decodeEntities(stripTags(s));
	s = s
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { title, description, text: s };
}

export function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, ' ');
}

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith('#x') || entity.startsWith('#X')) {
			return safeChar(Number.parseInt(entity.slice(2), 16), match);
		}
		if (entity.startsWith('#')) {
			return safeChar(Number.parseInt(entity.slice(1), 10), match);
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function safeChar(code: number, fallback: string): string {
	if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
		return fallback;
	}
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}

function resolveHref(href: string, baseUrl: string | undefined): string | null {
	const value = href.trim();
	if (!value || value.startsWith('#') || /^javascript:/i.test(value) || /^data:/i.test(value)) {
		return null;
	}
	if (/^(mailto|tel):/i.test(value)) {
		return value;
	}
	try {
		const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return null;
		}
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

function first(text: string, pattern: RegExp): string {
	return pattern.exec(text)?.[1] ?? '';
}

function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
