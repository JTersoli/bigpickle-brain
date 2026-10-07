import { describe, expect, it } from 'vitest';
import { extractAmounts, formatFinding, knowledgeCurrencies, matchService, parseAmount, parsePriceCatalog, runChecks, type Finding } from '../src/checks.ts';
import { proposalTotals } from '../src/proposalReport.ts';
import { sampleProposal } from './proposal.test.ts';
import { sampleReport } from './report.test.ts';

const spanishKnowledge = {
	name: 'Servicios',
	content: `# Servicios (AUD, sin GST)

| Servicio | Qué incluye | Precio bigpickle | Precio de mercado |
|---|---|---|---|
| Landing page | Una página, móvil y SEO básico | $500 – $600 | $700 – $900 |
| Landing page con captura de leads | Formulario y aviso por email | +$100 | +$150 |
| Sitio web de hasta 5 páginas | Marca, servicios, contacto | $1.000 – $1.500 | $1.800 – $2.500 |
| Tienda online estándar | Hasta 50 productos | $4.000 – $7.000 | $7.000 – $10.000 |

### IA y automatización

| Servicio | Precio de configuración |
|---|---|
| Chat con IA en el sitio web | $300 – $500 |
| **Agente de IA para turnos** | $800 – $1.500 |

| Servicio | Qué es | Precio bigpickle |
|---|---|---|
| Digital Foundation | Sitio estratégico (4 a 8 semanas) | $4.800 (5–10 páginas), $8.000 (10–20), $12.000 (más de 20) |
| Básico | Hosting, backup mensual | $50 por mes |

Las plataformas cuestan entre $50 y $150 por mes y las paga el cliente.
`,
};

const englishKnowledge = {
	name: 'agency',
	content: `## Services and prices (USD, excluding tax)

| Service | Includes | Price |
|---|---|---|
| Landing page | One page, mobile first | 500 – 700 |
| Business website | Up to 5 pages, menu or services, map, contact | 1,000 – 1,800 |
| Monthly care | Hosting, updates, backups | 60 – 150 per month |
`,
};

describe('parseAmount and extractAmounts', () => {
	it('reads thousands separators in both styles and decimals', () => {
		expect(parseAmount('1.000')).toBe(1000);
		expect(parseAmount('1,000')).toBe(1000);
		expect(parseAmount('12.500')).toBe(12500);
		expect(parseAmount('2560')).toBe(2560);
		expect(parseAmount('0.5')).toBe(0.5);
		expect(parseAmount('50,')).toBe(50);
	});

	it('takes only the signed amounts when a cell has a currency sign', () => {
		expect(extractAmounts('$4.800 (5–10 páginas), $8.000 (10–20), $12.000 (más de 20)')).toEqual([4800, 8000, 12000]);
		expect(extractAmounts('+$100')).toEqual([100]);
		expect(extractAmounts('AUD 500 – AUD 700')).toEqual([500, 700]);
		expect(extractAmounts('500 – 700')).toEqual([500, 700]);
		expect(extractAmounts('60 – 150 per month')).toEqual([60, 150]);
	});
});

describe('parsePriceCatalog', () => {
	it('reads the service and the first price column of every table, in Spanish and in English', () => {
		const catalog = parsePriceCatalog([spanishKnowledge, englishKnowledge]);
		expect(catalog.map((entry) => entry.name)).toEqual([
			'Landing page',
			'Landing page con captura de leads',
			'Sitio web de hasta 5 páginas',
			'Tienda online estándar',
			'Chat con IA en el sitio web',
			'Agente de IA para turnos',
			'Digital Foundation',
			'Básico',
			'Landing page',
			'Business website',
			'Monthly care',
		]);
		const byName = Object.fromEntries(catalog.map((entry) => [entry.name, entry]));
		expect(byName['Sitio web de hasta 5 páginas']).toMatchObject({ min: 1000, max: 1500, text: '$1.000 – $1.500', note: 'Servicios' });
		expect(byName['Landing page con captura de leads']).toMatchObject({ min: 100, max: 100 });
		expect(byName['Digital Foundation']).toMatchObject({ min: 4800, max: 12000 });
		expect(byName['Básico']).toMatchObject({ min: 50, max: 50 });
		expect(byName['Business website']).toMatchObject({ min: 1000, max: 1800, note: 'agency' });
	});

	it('ignores notes without tables', () => {
		expect(parsePriceCatalog([{ name: 'tone', content: '# Tone\n\nShort sentences. $100 is not a table.' }])).toEqual([]);
	});
});

describe('matchService', () => {
	const catalog = parsePriceCatalog([spanishKnowledge]);

	it('matches by name ignoring accents and case, then by containment and word overlap', () => {
		expect(matchService('sitio web de hasta 5 paginas', catalog)).toMatchObject({ exact: true, entry: { name: 'Sitio web de hasta 5 páginas' } });
		expect(matchService('Landing page', catalog)).toMatchObject({ exact: true, entry: { name: 'Landing page' } });
		expect(matchService('Landing page con captura', catalog)).toMatchObject({ exact: false, entry: { name: 'Landing page con captura de leads' } });
		expect(matchService('Chat con IA en el sitio', catalog)).toMatchObject({ exact: false, entry: { name: 'Chat con IA en el sitio web' } });
		expect(matchService('Fotografía de producto', catalog)).toBeUndefined();
		expect(matchService('', catalog)).toBeUndefined();
	});
});

describe('knowledgeCurrencies', () => {
	it('lists the codes the knowledge mentions, most frequent first', () => {
		expect(knowledgeCurrencies([spanishKnowledge, englishKnowledge])).toEqual(['AUD', 'USD']);
		expect(knowledgeCurrencies([{ name: 'x', content: 'no codes here' }])).toEqual([]);
	});
});

describe('runChecks', () => {
	const notes = [spanishKnowledge];

	it('passes a proposal whose items, prices and currency come from the knowledge', () => {
		const findings = runChecks({ proposal: sampleProposal, research: sampleReport, notes, totals: proposalTotals(sampleProposal) });
		// The only thing left to note: the chat item is not among the research's opportunities.
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: 'low', category: 'research', where: 'Ítem "Chat con IA"' });
		expect(findings[0]?.issue).toContain('"Chat con IA en el sitio web" no está entre las oportunidades');
	});

	it('flags prices outside the range, invented services, wrong totals, currency and language', () => {
		const proposal = {
			...sampleProposal,
			scope: [
				{ ...sampleProposal.scope[0]!, price_min: 800, price_max: 1800 },
				{ ...sampleProposal.scope[1]!, name: 'Pasarela de pagos', service: 'Integración con Stripe', price_min: 400, price_max: 600 },
				{ ...sampleProposal.scope[2]!, service: 'Agente de IA para turnos', price_note: '' },
				{ ...sampleProposal.scope[2]!, name: 'Video', service: 'Video institucional', price_note: '' },
			],
			timeline: [{ phase: 'Diseño', duration: 'week 1', work: 'Diseño', needs_from_client: '' }],
			investment: { ...sampleProposal.investment, currency: 'USD', total_min: 1000, total_max: 2000 },
			next_steps: [],
		};
		const findings = runChecks({ proposal, research: sampleReport, notes, totals: proposalTotals(proposal) });
		const summary = findings.map((finding) => `${finding.severity} ${finding.category} ${finding.where}`);
		expect(summary).toEqual([
			'high price Ítem "Sitio web con pedidos"',
			'medium price Ítem "Sitio web con pedidos"',
			'high service Ítem "Pasarela de pagos"',
			'medium price Ítem "Fotos de producto"',
			'low price Ítem "Video"',
			'medium price Inversión',
			'high price Inversión',
			'medium language Plazos',
			'low structure Próximos pasos',
			'low research Ítem "Pasarela de pagos"',
		]);
		expect(findings[0]?.issue).toBe('El mínimo (USD 800) está por debajo del mínimo de la base para "Sitio web de hasta 5 páginas" (USD 1.000).');
		expect(findings[0]?.evidence).toBe('Base de conocimiento ("Servicios"): Sitio web de hasta 5 páginas, $1.000 – $1.500.');
		expect(findings[2]?.issue).toBe('El servicio "Integración con Stripe" no está en la base de conocimiento, pero el ítem tiene precio.');
		expect(findings[3]?.issue).toBe('"Agente de IA para turnos" quedó a cotizar, pero la base lo cotiza en $800 – $1.500.');
		expect(findings[5]?.issue).toBe('El total escrito (USD 1.000 – USD 2.000) no es la suma de los ítems principales (USD 1.200 – USD 2.400).');
		expect(findings[6]?.issue).toBe('La propuesta está en USD, una moneda que la base no usa.');
		expect(findings[7]?.issue).toBe('Duraciones en otro idioma: week 1.');
	});

	it('writes English messages for English proposals and notices a name that differs from the knowledge', () => {
		const proposal = {
			...sampleProposal,
			language: 'en' as const,
			client_name: "Gina's Bakery Pty Ltd",
			scope: [{ ...sampleProposal.scope[0]!, service: 'Sitio web de 5 paginas' }],
			timeline: [{ phase: 'Design', duration: 'semana 1', work: 'Design', needs_from_client: '' }],
			investment: { ...sampleProposal.investment, total_min: 1000, total_max: 1500 },
		};
		const findings = runChecks({ proposal, research: sampleReport, notes, totals: proposalTotals(proposal) });
		expect(findings.map((finding) => `${finding.severity} ${finding.category}`)).toEqual(['low service', 'medium language', 'medium language', 'low other']);
		expect(findings[0]?.issue).toBe('The service is called "Sitio web de 5 paginas"; the knowledge calls it "Sitio web de hasta 5 páginas".');
		expect(findings[1]?.issue).toBe('The proposal is in "en" and the research in "es".');
		expect(findings[2]?.issue).toBe('Durations in the wrong language: semana 1.');
		expect(findings[3]?.issue).toBe('The proposal names the client "Gina\'s Bakery Pty Ltd"; the research says "Gina\'s Bakery".');
	});

	it('says nothing about prices when there is no knowledge, and flags an empty scope', () => {
		const proposal = { ...sampleProposal, scope: [], investment: { ...sampleProposal.investment, total_min: 0, total_max: 0 } };
		const findings = runChecks({ proposal, research: sampleReport, notes: [], totals: proposalTotals(proposal) });
		expect(findings.map((finding) => `${finding.severity} ${finding.category}`)).toEqual(['high structure']);
		expect(findings[0]?.issue).toBe('No hay ítems principales, así que no hay nada que cotizar.');
	});
});

describe('formatFinding', () => {
	it('writes one line with the evidence only when there is one', () => {
		const finding: Finding = { severity: 'high', category: 'technology', where: 'Item "Shop"', issue: 'Names Stripe.', evidence: 'Not in the knowledge.', fix: 'Remove it.' };
		expect(formatFinding(finding)).toBe('- [high] [technology] Item "Shop": Names Stripe. Evidence: Not in the knowledge. Fix: Remove it.');
		expect(formatFinding({ ...finding, evidence: ' ' })).toBe('- [high] [technology] Item "Shop": Names Stripe. Fix: Remove it.');
	});
});
