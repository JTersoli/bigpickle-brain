import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/tools/html.ts';

describe('htmlToText', () => {
	it('extracts the title, the description and readable text with links', () => {
		const html = `<html><head><title>Gina&#39;s Bakery | Bondi</title>
<meta name="description" content="Sourdough &amp; pastries"><style>.x{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/menu">Menu</a> <a href="#top">Top</a></nav><h1>Fresh every day</h1><p>We bake<br>at dawn.</p>
<ul><li>Bread</li><li>Cakes</li></ul><a href="https://instagram.com/ginas">Instagram</a><a href="mailto:hi@ginas.com">Email us</a>
<a href="javascript:void(0)">Click</a><img alt="the shop"><!-- hidden --><footer>&copy; 2026</footer></body></html>`;
		const page = htmlToText(html, 'https://ginas.example.com/');
		expect(page.title).toBe("Gina's Bakery | Bondi");
		expect(page.description).toBe('Sourdough & pastries');
		expect(page.text).toContain('# Fresh every day');
		expect(page.text).toContain('We bake\nat dawn.');
		expect(page.text).toContain('[Menu](https://ginas.example.com/menu)');
		expect(page.text).toContain('- Bread');
		expect(page.text).toContain('[Instagram](https://instagram.com/ginas)');
		expect(page.text).toContain('[Email us](mailto:hi@ginas.com)');
		expect(page.text).toContain('[image: the shop]');
		expect(page.text).toContain('© 2026');
		expect(page.text).not.toContain('alert(1)');
		expect(page.text).not.toContain('color:red');
		expect(page.text).not.toContain('hidden');
		expect(page.text).not.toContain('javascript:');
		expect(page.text).not.toContain('<');
	});

	it('reads the description when content comes before name', () => {
		const page = htmlToText('<meta content="Hello there" name="description"><p>x</p>');
		expect(page.description).toBe('Hello there');
	});

	it('collapses whitespace and runs of empty lines', () => {
		const page = htmlToText('<div>\n\n   a    </div>\n\n\n\n<div>b</div><span>c</span>');
		expect(page.text).toBe('a\n\nb\nc');
	});
});

describe('decodeEntities', () => {
	it('decodes named, decimal and hex entities and leaves unknown ones', () => {
		expect(decodeEntities('&euro;&#8364; &#x41; &amp; &unknown;')).toBe('&euro;€ A & &unknown;');
		expect(decodeEntities('caf&eacute;')).toBe('café');
	});
});
