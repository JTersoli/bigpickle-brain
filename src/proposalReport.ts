import type { Proposal } from './agents/proposal.ts';
import { describeUsage, type UsageTotals } from './pricing.ts';
import { safeNamePart } from './report.ts';

export interface ProposalMeta {
	date: string;
	model: string;
	provider: string;
	usage: UsageTotals;
	cost: number | null;
	durationMs: number;
	steps: number;
	/** Note name of the research report this proposal was written from, without the extension. */
	researchNoteName?: string;
	brief: string;
}

export interface ProposalTotals {
	min: number;
	max: number;
	/** True when the model's totals did not match the sum of the core items; the sum wins. */
	mismatch: boolean;
}

/** The totals the proposal shows: the sum of the core items, whatever the model wrote. */
export function proposalTotals(proposal: Proposal): ProposalTotals {
	const core = proposal.scope.filter((item) => item.priority === 'core');
	const min = core.reduce((sum, item) => sum + item.price_min, 0);
	const max = core.reduce((sum, item) => sum + item.price_max, 0);
	return { min, max, mismatch: min !== proposal.investment.total_min || max !== proposal.investment.total_max };
}

const LABELS = {
	en: {
		understanding: 'What we understood',
		objectives: 'Objectives',
		scope: 'What we propose',
		deliverables: 'Deliverables',
		optional: 'Optional',
		investment: 'Investment',
		toQuote: 'to quote',
		timeline: 'Timeline',
		phase: 'Phase',
		duration: 'Duration',
		work: 'What we do',
		needs: 'What we need from you',
		item: 'Item',
		service: 'Service',
		price: 'Price',
		total: 'Total',
		payment: 'Payment',
		market: 'At market rates',
		ongoing: 'Ongoing costs',
		outOfScope: 'Not included',
		nextSteps: 'Next steps',
		internal: 'Internal notes (do not send)',
		assumptions: 'Assumptions',
		alerts: 'Alerts',
		questions: 'Questions for the client',
		research: 'Research',
		brief: 'Brief',
		run: 'Run',
		none: 'None.',
		model: 'Model',
		stepsLine: 'Steps',
		durationLine: 'duration',
		tokens: 'Tokens',
		totalsCorrected: (said: string, sum: string) => `The model wrote a total of ${said}; the core items add up to ${sum}, which is what the proposal shows.`,
	},
	es: {
		understanding: 'Lo que entendimos',
		objectives: 'Objetivos',
		scope: 'Qué proponemos',
		deliverables: 'Entregables',
		optional: 'Opcional',
		investment: 'Inversión',
		toQuote: 'a cotizar',
		timeline: 'Plazos',
		phase: 'Fase',
		duration: 'Duración',
		work: 'Qué hacemos',
		needs: 'Qué necesitamos de tu parte',
		item: 'Ítem',
		service: 'Servicio',
		price: 'Precio',
		total: 'Total',
		payment: 'Pago',
		market: 'A precio de mercado',
		ongoing: 'Costos mensuales',
		outOfScope: 'No incluido',
		nextSteps: 'Próximos pasos',
		internal: 'Notas internas (no enviar)',
		assumptions: 'Supuestos',
		alerts: 'Alertas',
		questions: 'Preguntas para el cliente',
		research: 'Investigación',
		brief: 'Brief',
		run: 'Corrida',
		none: 'Nada.',
		model: 'Modelo',
		stepsLine: 'Pasos',
		durationLine: 'duración',
		tokens: 'Tokens',
		totalsCorrected: (said: string, sum: string) => `El modelo escribió un total de ${said}; los ítems principales suman ${sum}, que es lo que muestra la propuesta.`,
	},
} as const;

/** The proposal as an Obsidian-friendly Markdown note: the client-facing text first, the internal notes at the end. */
export function renderProposal(proposal: Proposal, meta: ProposalMeta): string {
	const t = LABELS[proposal.language];
	const totals = proposalTotals(proposal);
	const currency = proposal.investment.currency || 'AUD';
	const money = (value: number) => formatMoney(value, currency, proposal.language);
	const range = (min: number, max: number) => (min === max ? money(min) : `${money(min)} – ${money(max)}`);
	const core = proposal.scope.filter((item) => item.priority === 'core');
	const optional = proposal.scope.filter((item) => item.priority === 'optional');
	const lines: string[] = [];

	lines.push('---');
	lines.push('type: proposal');
	lines.push(`client: "${yaml(proposal.client_name)}"`);
	lines.push(`date: ${meta.date}`);
	lines.push(`language: ${proposal.language}`);
	lines.push('status: draft');
	lines.push(`currency: ${yaml(currency)}`);
	lines.push(`total_min: ${totals.min}`);
	lines.push(`total_max: ${totals.max}`);
	lines.push(`services: "${yaml(core.map((item) => item.service).join(', '))}"`);
	lines.push(`research: "${meta.researchNoteName ? yaml(`[[${meta.researchNoteName}]]`) : ''}"`);
	lines.push(`model: "${yaml(meta.model)}"`);
	lines.push(`updated: ${meta.date}`);
	lines.push('---');
	lines.push('');
	lines.push(`# ${proposal.title}`);
	lines.push('');
	lines.push(proposal.summary.trim());
	lines.push('');
	lines.push(`## ${t.understanding}`);
	lines.push('');
	lines.push(proposal.understanding.trim());
	lines.push('');
	lines.push(`## ${t.objectives}`);
	lines.push('');
	pushList(lines, proposal.objectives, t.none);
	lines.push('');
	lines.push(`## ${t.scope}`);
	lines.push('');
	if (core.length === 0) {
		lines.push(t.none);
		lines.push('');
	}
	core.forEach((item, index) => {
		lines.push(`### ${index + 1}. ${item.name}`);
		lines.push('');
		lines.push(item.description.trim());
		lines.push('');
		if (item.deliverables.length > 0) {
			lines.push(`**${t.deliverables}:**`);
			lines.push('');
			pushList(lines, item.deliverables, t.none);
			lines.push('');
		}
		lines.push(`**${t.investment}:** ${priceText(item, range, t.toQuote)}`);
		lines.push('');
	});
	if (optional.length > 0) {
		lines.push(`### ${t.optional}`);
		lines.push('');
		for (const item of optional) {
			lines.push(`- **${item.name}** (${priceText(item, range, t.toQuote)}): ${item.description.trim()}`);
		}
		lines.push('');
	}
	lines.push(`## ${t.timeline}`);
	lines.push('');
	if (proposal.timeline.length === 0) {
		lines.push(t.none);
	} else {
		lines.push(`| ${t.phase} | ${t.duration} | ${t.work} | ${t.needs} |`);
		lines.push('|---|---|---|---|');
		for (const phase of proposal.timeline) {
			lines.push(`| ${cell(phase.phase)} | ${cell(phase.duration)} | ${cell(phase.work)} | ${cell(phase.needs_from_client)} |`);
		}
	}
	lines.push('');
	lines.push(`## ${t.investment}`);
	lines.push('');
	lines.push(`| ${t.item} | ${t.service} | ${t.price} |`);
	lines.push('|---|---|---|');
	for (const item of core) {
		lines.push(`| ${cell(item.name)} | ${cell(item.service)} | ${cell(priceText(item, range, t.toQuote))} |`);
	}
	lines.push(`| **${t.total}** | | **${range(totals.min, totals.max)}** |`);
	lines.push('');
	if (proposal.investment.payment_terms.trim()) {
		lines.push(`- **${t.payment}:** ${proposal.investment.payment_terms.trim()}`);
	}
	if (proposal.investment.market_comparison.trim()) {
		lines.push(`- **${t.market}:** ${proposal.investment.market_comparison.trim()}`);
	}
	if (proposal.investment.ongoing.trim()) {
		lines.push(`- **${t.ongoing}:** ${proposal.investment.ongoing.trim()}`);
	}
	lines.push('');
	lines.push(`## ${t.outOfScope}`);
	lines.push('');
	pushList(lines, proposal.out_of_scope, t.none);
	lines.push('');
	lines.push(`## ${t.nextSteps}`);
	lines.push('');
	pushNumbered(lines, proposal.next_steps, t.none);
	lines.push('');
	lines.push('---');
	lines.push('');
	lines.push(`## ${t.internal}`);
	lines.push('');
	const alerts = [...proposal.internal.alerts];
	if (totals.mismatch) {
		alerts.unshift(t.totalsCorrected(range(proposal.investment.total_min, proposal.investment.total_max), range(totals.min, totals.max)));
	}
	lines.push(`**${t.alerts}:**`);
	lines.push('');
	pushList(lines, alerts, t.none);
	lines.push('');
	lines.push(`**${t.assumptions}:**`);
	lines.push('');
	pushList(lines, proposal.internal.assumptions, t.none);
	lines.push('');
	lines.push(`**${t.questions}:**`);
	lines.push('');
	pushNumbered(lines, proposal.internal.questions_for_client, t.none);
	lines.push('');
	if (meta.researchNoteName) {
		lines.push(`- ${t.research}: [[${meta.researchNoteName}]]`);
	}
	if (meta.brief.trim()) {
		lines.push(`- ${t.brief}: ${meta.brief.trim().replace(/\s*\n+\s*/g, ' ')}`);
	}
	lines.push(`- ${t.model}: ${meta.provider.includes(meta.model) ? meta.provider : `${meta.model} (${meta.provider})`}`);
	lines.push(`- ${t.stepsLine}: ${meta.steps}, ${t.durationLine}: ${(meta.durationMs / 1000).toFixed(0)} s`);
	lines.push(`- ${t.tokens}: ${describeUsage(meta.usage, meta.cost)}`);
	lines.push('');

	return lines.join('\n');
}

/** `2026-10-01 Proposal Client.md` */
export function proposalFileName(date: string, client: string, language: Proposal['language']): string {
	const word = language === 'es' ? 'Propuesta' : 'Proposal';
	return `${date} ${word} ${safeNamePart(client)}.md`;
}

export function formatMoney(value: number, currency: string, language: Proposal['language']): string {
	return `${currency} ${value.toLocaleString(language === 'es' ? 'es-AR' : 'en-AU', { maximumFractionDigits: 0 })}`;
}

function priceText(item: Proposal['scope'][number], range: (min: number, max: number) => string, toQuote: string): string {
	if (item.price_min === 0 && item.price_max === 0) {
		return item.price_note.trim() || toQuote;
	}
	return range(item.price_min, item.price_max);
}

function pushList(lines: string[], items: string[], none: string): void {
	if (items.length === 0) {
		lines.push(none);
		return;
	}
	for (const item of items) {
		lines.push(`- ${item.trim()}`);
	}
}

function pushNumbered(lines: string[], items: string[], none: string): void {
	if (items.length === 0) {
		lines.push(none);
		return;
	}
	items.forEach((item, index) => {
		lines.push(`${index + 1}. ${item.trim()}`);
	});
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();
}

function yaml(text: string): string {
	return text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}
