import { describe, expect, it } from 'vitest';
import type { ResearchReport } from '../src/agents/research.ts';
import { renderResearchReport, reportFileName } from '../src/report.ts';

export const sampleReport: ResearchReport = {
	client_name: "Gina's Bakery",
	website: 'https://ginas.example.com',
	language: 'es',
	summary: 'Panadería artesanal de Bondi. Vende por Instagram y no tiene web.',
	business: { industry: 'Panadería', location: 'Bondi, Sydney, Australia', size_estimate: '1 local', segment: 'smb' },
	digital_presence: [
		{ channel: 'website', status: 'not_found', notes: 'El brief dice que no tienen | y no apareció ninguna' },
		{ channel: 'instagram', status: 'found', notes: 'Nombrado en el brief' },
	],
	problems: [{ problem: 'Sin sitio web', evidence: 'Brief', impact: 'high' }],
	competitors: [{ name: 'Otra panadería', url: 'https://otra.example.com', notes: 'not verified' }],
	opportunities: [{ service: 'Sitio web de hasta 5 páginas', why: 'Base digital', price_range: '$1.000 – $1.500', priority: 'high' }],
	questions_for_client: ['¿Cuántos pedidos reciben por semana?'],
	sources: [{ url: 'https://ginas.example.com', used_for: 'home' }],
	confidence: 'medium',
	confidence_notes: 'Solo se leyó la home.',
};

const meta = {
	date: '2026-09-30',
	model: 'claude-opus-5-5',
	provider: 'claude-opus-5-5 on the Claude API',
	usage: { requests: 4, inputTokens: 12000, outputTokens: 2500, cacheReadTokens: 9000, cacheWriteTokens: 3000 },
	cost: 0.1234,
	durationMs: 61_500,
	steps: 4,
	fetches: 2,
	brief: 'Gina\'s Bakery, panadería en Bondi.\nSin web.',
};

describe('renderResearchReport', () => {
	it('renders a Spanish note with frontmatter, tables and the run summary', () => {
		const markdown = renderResearchReport(sampleReport, meta);
		expect(markdown.startsWith('---\ntype: research\nclient: "Gina\'s Bakery"\nwebsite: "https://ginas.example.com"\ndate: 2026-09-30\n')).toBe(true);
		expect(markdown).toContain("# Gina's Bakery: investigación");
		expect(markdown).toContain('## Resumen');
		expect(markdown).toContain('- **Segmento:** pyme');
		expect(markdown).toContain('| Website | no | El brief dice que no tienen \\| y no apareció ninguna |');
		expect(markdown).toContain('1. **Sin sitio web** (impacto: alta). Evidencia: Brief');
		expect(markdown).toContain('- **Otra panadería** (https://otra.example.com): not verified');
		expect(markdown).toContain('| Sitio web de hasta 5 páginas | Base digital | $1.000 – $1.500 | alta |');
		expect(markdown).toContain('**media.** Solo se leyó la home.');
		expect(markdown).toContain("> Gina's Bakery, panadería en Bondi.\n> Sin web.");
		expect(markdown).toContain('- Pasos: 4, páginas leídas: 2, duración: 62 s');
		expect(markdown).toContain('cost: ~$0.1234');
	});

	it('uses English headings for English reports', () => {
		const markdown = renderResearchReport({ ...sampleReport, language: 'en', competitors: [], questions_for_client: [] }, { ...meta, cost: null });
		expect(markdown).toContain("# Gina's Bakery: research");
		expect(markdown).toContain('## Competitors\n\nNone.');
		expect(markdown).toContain('## Questions for the client\n\nNone.');
		expect(markdown).toContain('cost: n/a');
	});
});

describe('reportFileName', () => {
	it('builds a safe, readable file name', () => {
		expect(reportFileName('2026-09-30', 'Gina: "The" Bakery/Bondi [#1]', 'en')).toBe('2026-09-30 Research Gina The Bakery Bondi 1.md');
		expect(reportFileName('2026-09-30', '   ', 'es')).toBe('2026-09-30 Investigación client.md');
	});
});
