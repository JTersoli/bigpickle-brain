import { describe, expect, it } from 'vitest';
import { buildProposalMessage, ProposalSchema, type Proposal } from '../src/agents/proposal.ts';
import { formatMoney, proposalFileName, proposalTotals, renderProposal } from '../src/proposalReport.ts';
import { sampleReport } from './report.test.ts';

export const sampleProposal: Proposal = {
	client_name: "Gina's Bakery",
	language: 'es',
	title: "Gina's Bakery: pedidos online sin depender de Instagram",
	summary: 'Hoy los pedidos llegan por mensajes y se pierden. Proponemos un sitio con pedidos y un chat con IA.',
	understanding: 'Panadería artesanal de Bondi con un local. Vende por Instagram y no tiene web.',
	objectives: ['Recibir pedidos sin mensajes manuales', 'Aparecer en Google'],
	scope: [
		{
			name: 'Sitio web con pedidos',
			service: 'Sitio web de hasta 5 páginas',
			description: 'Un sitio de cinco páginas con el menú y los pedidos.',
			deliverables: ['Diseño', 'Menú actualizable', 'Formulario de pedidos'],
			price_min: 1000,
			price_max: 1500,
			price_note: '',
			priority: 'core',
		},
		{
			name: 'Chat con IA',
			service: 'Chat con IA en el sitio web',
			description: 'Responde horarios y pedidos las 24 horas.',
			deliverables: ['Widget configurado'],
			price_min: 300,
			price_max: 500,
			price_note: '',
			priority: 'core',
		},
		{
			name: 'Fotos de producto',
			service: 'Fotografía',
			description: 'Sesión de fotos para el menú.',
			deliverables: ['20 fotos'],
			price_min: 0,
			price_max: 0,
			price_note: 'a cotizar con un fotógrafo',
			priority: 'optional',
		},
	],
	out_of_scope: ['Publicidad paga'],
	timeline: [
		{ phase: 'Diseño', duration: 'semana 1', work: 'Estructura y diseño', needs_from_client: 'Logo y menú' },
		{ phase: 'Desarrollo', duration: 'semanas 2 y 3', work: 'Sitio y pedidos', needs_from_client: 'Revisar la vista previa' },
	],
	investment: {
		currency: 'AUD',
		total_min: 1300,
		total_max: 2000,
		payment_terms: '50 % al firmar y 50 % a mitad del proyecto',
		market_comparison: 'En el mercado, entre AUD 2.100 y 3.400',
		ongoing: 'Mantenimiento desde AUD 50 por mes',
	},
	next_steps: ['Confirmar el alcance', 'Firmar y pagar el 50 %', 'Reunión de inicio'],
	internal: {
		assumptions: ['El menú tiene menos de 40 productos'],
		alerts: ['La competencia no fue verificada'],
		questions_for_client: ['¿Cuántos pedidos reciben por semana?'],
	},
};

const meta = {
	date: '2026-10-01',
	model: 'claude-opus-5-5',
	provider: 'claude-opus-5-5 on the Claude API',
	usage: { requests: 3, inputTokens: 9000, outputTokens: 2000, cacheReadTokens: 6000, cacheWriteTokens: 0 },
	cost: 0.08,
	durationMs: 40_000,
	steps: 3,
	researchNoteName: "2026-10-01 Investigación Gina's Bakery",
	brief: "Gina's Bakery, panadería en Bondi.\nSin web.",
};

describe('ProposalSchema', () => {
	it('accepts the sample and rejects a wrong priority', () => {
		expect(ProposalSchema.safeParse(sampleProposal).success).toBe(true);
		const broken = { ...sampleProposal, scope: [{ ...sampleProposal.scope[0], priority: 'maybe' }] };
		expect(ProposalSchema.safeParse(broken).success).toBe(false);
	});
});

describe('buildProposalMessage', () => {
	it('carries the brief, the research as JSON and the language', () => {
		const message = buildProposalMessage({ brief: 'Brief text', research: sampleReport, clientName: "Gina's Bakery", today: '2026-10-01', language: 'es' });
		expect(message).toContain('<brief>\nBrief text\n</brief>');
		expect(message).toContain('<research_report>\n{\n  "client_name": "Gina\'s Bakery"');
		expect(message).toContain("Client name: Gina's Bakery");
		expect(message).toContain('Language of the proposal: Spanish (es)');
		expect(message).toContain('submit_proposal');

		const bare = buildProposalMessage({ brief: '  ', research: sampleReport, today: '2026-10-01' });
		expect(bare).toContain('No brief was given');
		expect(bare).toContain('Language of the proposal: the language of the brief');
	});
});

describe('proposalTotals', () => {
	it('sums the core items only and flags a mismatch', () => {
		expect(proposalTotals(sampleProposal)).toEqual({ min: 1300, max: 2000, mismatch: false });
		const off = { ...sampleProposal, investment: { ...sampleProposal.investment, total_max: 2500 } };
		expect(proposalTotals(off)).toEqual({ min: 1300, max: 2000, mismatch: true });
	});
});

describe('renderProposal', () => {
	it('renders a Spanish note with frontmatter, scope, tables and internal notes', () => {
		const markdown = renderProposal(sampleProposal, meta);
		expect(markdown.startsWith("---\ntype: proposal\nclient: \"Gina's Bakery\"\ndate: 2026-10-01\nlanguage: es\nstatus: draft\ncurrency: AUD\ntotal_min: 1300\ntotal_max: 2000\n")).toBe(true);
		expect(markdown).toContain('services: "Sitio web de hasta 5 páginas, Chat con IA en el sitio web"');
		expect(markdown).toContain('research: "[[2026-10-01 Investigación Gina\'s Bakery]]"');
		expect(markdown).toContain("# Gina's Bakery: pedidos online sin depender de Instagram");
		expect(markdown).toContain('## Lo que entendimos');
		expect(markdown).toContain('### 1. Sitio web con pedidos');
		expect(markdown).toContain('**Inversión:** AUD 1.000 – AUD 1.500');
		expect(markdown).toContain('### Opcional\n\n- **Fotos de producto** (a cotizar con un fotógrafo): Sesión de fotos para el menú.');
		expect(markdown).toContain('| Diseño | semana 1 | Estructura y diseño | Logo y menú |');
		expect(markdown).toContain('| **Total** | | **AUD 1.300 – AUD 2.000** |');
		expect(markdown).toContain('- **Pago:** 50 % al firmar y 50 % a mitad del proyecto');
		expect(markdown).toContain('## Notas internas (no enviar)');
		expect(markdown).toContain('- La competencia no fue verificada');
		expect(markdown).toContain("- Investigación: [[2026-10-01 Investigación Gina's Bakery]]");
		expect(markdown).toContain("- Brief: Gina's Bakery, panadería en Bondi. Sin web.");
		expect(markdown).toContain('cost: ~$0.0800');
		expect(markdown.indexOf('## Notas internas')).toBeGreaterThan(markdown.indexOf('## Próximos pasos'));
	});

	it('corrects the totals from the core items and says so', () => {
		const off = { ...sampleProposal, language: 'en' as const, investment: { ...sampleProposal.investment, total_min: 1000, total_max: 1500 } };
		const markdown = renderProposal(off, { ...meta, cost: null, researchNoteName: undefined, brief: '' });
		expect(markdown).toContain('| **Total** | | **AUD 1,300 – AUD 2,000** |');
		expect(markdown).toContain('The model wrote a total of AUD 1,000 – AUD 1,500; the core items add up to AUD 1,300 – AUD 2,000');
		expect(markdown).toContain('research: ""');
		expect(markdown).not.toContain('- Research:');
		expect(markdown).toContain('## Internal notes (do not send)');
	});
});

describe('names and money', () => {
	it('builds file names and formats money per language', () => {
		expect(proposalFileName('2026-10-01', 'Gina: Bakery/Bondi', 'es')).toBe('2026-10-01 Propuesta Gina Bakery Bondi.md');
		expect(proposalFileName('2026-10-01', '', 'en')).toBe('2026-10-01 Proposal client.md');
		expect(formatMoney(12500, 'AUD', 'es')).toBe('AUD 12.500');
		expect(formatMoney(12500, 'USD', 'en')).toBe('USD 12,500');
	});
});
