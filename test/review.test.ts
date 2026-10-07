import { describe, expect, it } from 'vitest';
import { buildReviewMessage, ReviewSchema, type Review } from '../src/agents/review.ts';
import type { Finding } from '../src/checks.ts';
import { describeVerdict, finalVerdict, mergeFindings, renderReview, reviewFileName, type ReviewFinding } from '../src/reviewReport.ts';
import { sampleProposal } from './proposal.test.ts';
import { sampleReport } from './report.test.ts';

export const sampleReview: Review = {
	client_name: "Gina's Bakery",
	language: 'es',
	verdict: 'approve',
	summary: 'La propuesta sigue la investigación y cotiza con los precios de la base. Se puede mandar.',
	findings: [],
	strengths: ['Los dos ítems principales salen de los problemas de alto impacto', 'Precios dentro de los rangos'],
	checked: ['Precios y nombres de servicio contra la base', 'Condiciones de pago'],
};

export const modelFinding: Finding = {
	severity: 'high',
	category: 'technology',
	where: 'Ítem "Sitio web con pedidos"',
	issue: 'Nombra Stripe como pasarela de pago.',
	evidence: 'Ni la base ni la investigación mencionan Stripe.',
	fix: 'Sacar el nombre de la pasarela o dejarlo como "a definir con el cliente".',
};

const codeFinding: Finding = {
	severity: 'low',
	category: 'research',
	where: 'Ítem "Chat con IA"',
	issue: '"Chat con IA en el sitio web" no está entre las oportunidades que encontró la investigación.',
	evidence: 'Oportunidades de la investigación: Sitio web de hasta 5 páginas.',
	fix: 'Confirmar que el brief o la investigación lo justifican.',
};

const meta = {
	date: '2026-10-07',
	model: 'claude-opus-5-5',
	provider: 'claude-opus-5-5 on the Claude API',
	usage: { requests: 2, inputTokens: 11000, outputTokens: 1200, cacheReadTokens: 8000, cacheWriteTokens: 0 },
	cost: 0.05,
	durationMs: 30_000,
	steps: 2,
	proposalNoteName: "2026-10-07 Propuesta Gina's Bakery",
	researchNoteName: "2026-10-07 Investigación Gina's Bakery",
	brief: "Gina's Bakery, panadería en Bondi.\nSin web.",
};

describe('ReviewSchema', () => {
	it('accepts the sample and rejects an unknown verdict or category', () => {
		expect(ReviewSchema.safeParse(sampleReview).success).toBe(true);
		expect(ReviewSchema.safeParse({ ...sampleReview, verdict: 'maybe' }).success).toBe(false);
		expect(ReviewSchema.safeParse({ ...sampleReview, findings: [{ ...modelFinding, category: 'vibes' }] }).success).toBe(false);
	});
});

describe('buildReviewMessage', () => {
	it('carries the brief, the research, the proposal and the automated findings as data', () => {
		const message = buildReviewMessage({ brief: 'Brief text', research: sampleReport, proposal: sampleProposal, checks: [codeFinding], clientName: "Gina's Bakery", today: '2026-10-07', language: 'es' });
		expect(message).toContain('<brief>\nBrief text\n</brief>');
		expect(message).toContain('<research_report>\n{\n  "client_name": "Gina\'s Bakery"');
		expect(message).toContain('<proposal>\n{\n  "client_name": "Gina\'s Bakery"');
		expect(message).toContain('<automated_checks>\n- [low] [research] Ítem "Chat con IA": "Chat con IA en el sitio web" no está entre las oportunidades');
		expect(message).toContain('Language of the review: Spanish (es)');
		expect(message).toContain('submit_review');

		const clean = buildReviewMessage({ brief: '', research: sampleReport, proposal: sampleProposal, checks: [], today: '2026-10-07' });
		expect(clean).toContain('No brief was given');
		expect(clean).toContain('<automated_checks>\nNo findings:');
		expect(clean).toContain('Language of the review: the language of the proposal (es)');
	});
});

describe('mergeFindings and finalVerdict', () => {
	it('puts the most serious findings first and tags where each came from', () => {
		const merged = mergeFindings([codeFinding], { ...sampleReview, findings: [modelFinding] });
		expect(merged.map((finding) => `${finding.severity} ${finding.source}`)).toEqual(['high model', 'low code']);
	});

	it('keeps the model verdict when the findings allow it and raises it when they do not', () => {
		expect(finalVerdict(sampleReview, [])).toEqual({ verdict: 'approve', overridden: false });
		expect(finalVerdict(sampleReview, [{ ...codeFinding, source: 'code' }])).toEqual({ verdict: 'approve', overridden: false });
		expect(finalVerdict(sampleReview, [{ ...modelFinding, source: 'model' }])).toEqual({ verdict: 'revise', overridden: true });
		expect(finalVerdict(sampleReview, [{ ...codeFinding, severity: 'medium', source: 'code' }])).toEqual({ verdict: 'revise', overridden: true });
		expect(finalVerdict({ ...sampleReview, verdict: 'reject' }, [{ ...modelFinding, source: 'model' }])).toEqual({ verdict: 'reject', overridden: false });
		expect(finalVerdict({ ...sampleReview, verdict: 'revise' }, [])).toEqual({ verdict: 'revise', overridden: false });
	});
});

describe('renderReview', () => {
	it('renders a Spanish note with the verdict, the findings and the links', () => {
		const findings: ReviewFinding[] = [
			{ ...modelFinding, source: 'model' },
			{ ...codeFinding, source: 'code' },
		];
		const markdown = renderReview({ ...sampleReview, findings: [modelFinding] }, findings, { verdict: 'revise', overridden: true }, meta);
		expect(markdown.startsWith("---\ntype: review\nclient: \"Gina's Bakery\"\ndate: 2026-10-07\nlanguage: es\nverdict: revise\nfindings: 2\nhigh: 1\n")).toBe(true);
		expect(markdown).toContain('proposal: "[[2026-10-07 Propuesta Gina\'s Bakery]]"');
		expect(markdown).toContain('research: "[[2026-10-07 Investigación Gina\'s Bakery]]"');
		expect(markdown).toContain("# Gina's Bakery: revisión de la propuesta");
		expect(markdown).toContain('**Veredicto: revisar.** La propuesta sigue la investigación');
		expect(markdown).toContain('El modelo dijo "aprobar", pero los hallazgos incluyen 1 de gravedad alta y 0 media');
		expect(markdown).toContain('## Hallazgos (1 alta, 0 media, 1 baja)');
		expect(markdown).toContain('1. **[alta] Ítem "Sitio web con pedidos":** Nombra Stripe como pasarela de pago. Evidencia: Ni la base ni la investigación mencionan Stripe. Cambio: Sacar el nombre de la pasarela o dejarlo como "a definir con el cliente". *(revisor)*');
		expect(markdown).toContain('2. **[baja] Ítem "Chat con IA":**');
		expect(markdown).toContain('*(chequeos)*');
		expect(markdown).toContain('## Lo que está bien\n\n- Los dos ítems principales');
		expect(markdown).toContain('## Qué se revisó y está bien\n\n- Precios y nombres de servicio contra la base');
		expect(markdown).toContain("- Propuesta: [[2026-10-07 Propuesta Gina's Bakery]]");
		expect(markdown).toContain("- Investigación: [[2026-10-07 Investigación Gina's Bakery]]");
		expect(markdown).toContain("- Brief: Gina's Bakery, panadería en Bondi. Sin web.");
		expect(markdown).toContain('cost: ~$0.0500');
	});

	it('uses English labels and says when there is nothing to change', () => {
		const markdown = renderReview({ ...sampleReview, language: 'en', strengths: [], checked: [] }, [], { verdict: 'approve', overridden: false }, { ...meta, cost: null, proposalNoteName: undefined, researchNoteName: undefined, brief: '' });
		expect(markdown).toContain("# Gina's Bakery: review of the proposal");
		expect(markdown).toContain('**Verdict: approve.**');
		expect(markdown).not.toContain('The model said');
		expect(markdown).toContain('## Findings (0 high, 0 medium, 0 low)\n\nNothing to change.');
		expect(markdown).toContain('## What works\n\nNone.');
		expect(markdown).toContain('proposal: ""');
		expect(markdown).not.toContain('- Proposal:');
		expect(markdown).toContain('cost: n/a');
	});
});

describe('names and verdict lines', () => {
	it('builds file names per language and describes a verdict with its counts', () => {
		expect(reviewFileName('2026-10-07', 'Gina: Bakery/Bondi', 'es')).toBe('2026-10-07 Revisión Gina Bakery Bondi.md');
		expect(reviewFileName('2026-10-07', '', 'en')).toBe('2026-10-07 Review client.md');
		expect(describeVerdict('revise', [modelFinding, codeFinding])).toBe('revise (1 high, 0 medium, 1 low)');
	});
});
