import type { Proposal } from './agents/proposal.ts';
import type { ReportLanguage, ResearchReport } from './agents/research.ts';
import { formatMoney, type ProposalTotals } from './proposalReport.ts';
import type { KnowledgeNote } from './tools/knowledge.ts';

export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = ['price', 'service', 'technology', 'promise', 'research', 'terms', 'language', 'structure', 'other'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** One thing wrong with a proposal, found by the code or by the review agent. */
export interface Finding {
	severity: FindingSeverity;
	category: FindingCategory;
	/** The section or scope item, as the proposal names it. */
	where: string;
	issue: string;
	/** What in the brief, the research, the notes or the knowledge contradicts or fails to support it. */
	evidence: string;
	fix: string;
}

/** A service and its price range, as read from a table in the knowledge notes. */
export interface CatalogEntry {
	name: string;
	min: number;
	max: number;
	/** The price cell as written, for messages. */
	text: string;
	/** The knowledge note it came from. */
	note: string;
}

/** A cell that starts with an amount, after an optional prefix such as "+", "from" or "desde". */
const PRICE_CELL = /^\s*(?:\+|~|[Dd]esde|[Ff]rom|[Aa] partir de)?\s*(?:[A-Z]{3}\s?)?\$?\s*\d/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;

/**
 * Reads every Markdown table in the knowledge notes and keeps the rows that carry a price:
 * the first cell is the service, the first cell that starts with an amount is its price.
 * A cell with several amounts ("$4,800 (5 pages), $8,000 (10 pages)") becomes one range.
 */
export function parsePriceCatalog(notes: KnowledgeNote[]): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const note of notes) {
		for (const line of note.content.split(/\r?\n/)) {
			if (!line.trim().startsWith('|')) {
				continue;
			}
			const cells = splitRow(line);
			if (cells.length < 2 || cells.every((cell) => cell === '' || SEPARATOR_CELL.test(cell))) {
				continue;
			}
			const name = (cells[0] ?? '').replace(/\*\*/g, '').trim();
			const priceCell = cells.slice(1).find((cell) => PRICE_CELL.test(cell));
			if (!name || !priceCell) {
				continue;
			}
			const amounts = extractAmounts(priceCell);
			if (amounts.length === 0) {
				continue;
			}
			entries.push({ name, min: Math.min(...amounts), max: Math.max(...amounts), text: priceCell.trim(), note: note.name });
		}
	}
	return entries;
}

function splitRow(line: string): string[] {
	const cells = line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replace(/\\\|/g, '|').trim());
	return cells;
}

/** The amounts in a price cell. With a currency sign only the signed amounts count, so "(5 pages)" is not a price. */
export function extractAmounts(cell: string): number[] {
	let pattern: RegExp;
	if (cell.includes('$')) {
		pattern = /\$\s?(\d[\d.,]*)/g;
	} else if (/\b[A-Z]{3}\s?\d/.test(cell)) {
		pattern = /\b[A-Z]{3}\s?(\d[\d.,]*)/g;
	} else {
		pattern = /(\d[\d.,]*)/g;
	}
	const amounts: number[] = [];
	for (const match of cell.matchAll(pattern)) {
		const value = parseAmount(match[1] ?? '');
		if (Number.isFinite(value)) {
			amounts.push(value);
		}
	}
	return amounts;
}

/** "1.000", "1,000" and "1000" are a thousand; "0.5" and "0,5" are a half. */
export function parseAmount(text: string): number {
	const cleaned = text.replace(/[.,]+$/, '');
	if (/^\d{1,3}(?:[.,]\d{3})+$/.test(cleaned)) {
		return Number(cleaned.replace(/[.,]/g, ''));
	}
	const decimal = /^(\d+)[.,](\d{1,2})$/.exec(cleaned);
	if (decimal) {
		return Number(`${decimal[1]}.${decimal[2]}`);
	}
	return Number(cleaned.replace(/[.,]/g, ''));
}

export function normalizeName(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export interface ServiceMatch {
	entry: CatalogEntry;
	/** True when the names are the same once accents, case and punctuation are ignored. */
	exact: boolean;
}

/** Finds the catalog entry a service name refers to: by name, by containment, then by word overlap. */
export function matchService(service: string, catalog: CatalogEntry[]): ServiceMatch | undefined {
	const key = normalizeName(service);
	if (!key) {
		return undefined;
	}
	const exact = catalog.find((entry) => normalizeName(entry.name) === key);
	if (exact) {
		return { entry: exact, exact: true };
	}
	const keyWords = new Set(key.split(' '));
	const scored = catalog.map((entry) => {
		const name = normalizeName(entry.name);
		const words = new Set(name.split(' '));
		const shared = [...keyWords].filter((word) => words.has(word)).length;
		const jaccard = shared / new Set([...keyWords, ...words]).size;
		const contains = key.includes(name) || name.includes(key);
		return { entry, score: contains ? 1 + jaccard : jaccard };
	});
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0];
	if (best && best.score >= 0.6) {
		return { entry: best.entry, exact: false };
	}
	return undefined;
}

export interface ChecksInput {
	proposal: Proposal;
	research: ResearchReport;
	notes: KnowledgeNote[];
	totals: ProposalTotals;
}

/**
 * The checks that do not need a model: prices and service names against the knowledge, totals,
 * currency, language, empty sections and coverage of the research. Their findings go to the review
 * agent as input and to the review note as they are.
 */
export function runChecks(input: ChecksInput): Finding[] {
	const { proposal, research, totals } = input;
	const t = TEXT[proposal.language];
	const catalog = parsePriceCatalog(input.notes);
	const currency = proposal.investment.currency || 'AUD';
	const money = (value: number) => formatMoney(value, currency, proposal.language);
	const findings: Finding[] = [];
	const catalogNames = catalog.map((entry) => entry.name).join(', ');

	for (const item of proposal.scope) {
		const where = t.item(item.name);
		const priced = item.price_min > 0 || item.price_max > 0;
		if (item.price_min > item.price_max) {
			findings.push({ severity: 'high', category: 'price', where, issue: t.inverted(money(item.price_min), money(item.price_max)), evidence: '', fix: t.fixInverted });
		}
		const match = catalog.length > 0 ? matchService(item.service, catalog) : undefined;
		if (!match) {
			if (catalog.length > 0 && priced) {
				findings.push({ severity: 'high', category: 'service', where, issue: t.notInKnowledge(item.service), evidence: t.evidenceCatalog(catalogNames), fix: t.fixNotInKnowledge });
			} else if (!priced && !item.price_note.trim()) {
				findings.push({ severity: 'low', category: 'price', where, issue: t.noPriceNoNote(item.service), evidence: '', fix: t.fixNoPriceNoNote });
			}
			continue;
		}
		const { entry } = match;
		const evidence = t.evidenceEntry(entry.name, entry.text, entry.note);
		if (!match.exact) {
			findings.push({ severity: 'low', category: 'service', where, issue: t.nameDiffers(item.service, entry.name), evidence, fix: t.fixName });
		}
		if (!priced) {
			findings.push({ severity: 'medium', category: 'price', where, issue: t.hasPrice(item.service, entry.text), evidence, fix: t.fixHasPrice });
			continue;
		}
		if (item.price_min < entry.min) {
			findings.push({ severity: 'high', category: 'price', where, issue: t.below(money(item.price_min), entry.name, money(entry.min)), evidence, fix: t.fixRange(entry.text) });
		}
		if (item.price_max > entry.max) {
			findings.push({ severity: 'medium', category: 'price', where, issue: t.above(money(item.price_max), entry.name, money(entry.max)), evidence, fix: t.fixRange(entry.text) });
		}
	}

	if (totals.mismatch) {
		const said = `${money(proposal.investment.total_min)} – ${money(proposal.investment.total_max)}`;
		const sum = `${money(totals.min)} – ${money(totals.max)}`;
		findings.push({ severity: 'medium', category: 'price', where: t.investment, issue: t.totals(said, sum), evidence: '', fix: t.fixTotals });
	}

	const currencies = knowledgeCurrencies(input.notes);
	if (currencies.length > 0 && !currencies.includes(currency.toUpperCase())) {
		findings.push({ severity: 'high', category: 'price', where: t.investment, issue: t.currency(currency), evidence: t.evidenceCurrency(currencies.join(', ')), fix: t.fixCurrency });
	}

	if (proposal.language !== research.language) {
		findings.push({ severity: 'medium', category: 'language', where: t.general, issue: t.languageMismatch(proposal.language, research.language), evidence: '', fix: t.fixLanguage });
	}
	const foreign = FOREIGN_DURATION[proposal.language];
	const durations = proposal.timeline.map((phase) => phase.duration).filter((duration) => foreign.test(duration));
	if (durations.length > 0) {
		findings.push({ severity: 'medium', category: 'language', where: t.timeline, issue: t.durationLanguage(durations.join('; ')), evidence: '', fix: t.fixDuration });
	}

	const core = proposal.scope.filter((item) => item.priority === 'core');
	if (core.length === 0) {
		findings.push({ severity: 'high', category: 'structure', where: t.scope, issue: t.noCore, evidence: '', fix: t.fixNoCore });
	}
	if (proposal.timeline.length === 0) {
		findings.push({ severity: 'medium', category: 'structure', where: t.timeline, issue: t.noTimeline, evidence: '', fix: t.fixNoTimeline });
	}
	if (proposal.next_steps.length === 0) {
		findings.push({ severity: 'low', category: 'structure', where: t.nextSteps, issue: t.noNextSteps, evidence: '', fix: t.fixNoNextSteps });
	}
	if (proposal.objectives.length === 0) {
		findings.push({ severity: 'low', category: 'structure', where: t.objectives, issue: t.noObjectives, evidence: '', fix: t.fixNoObjectives });
	}

	const opportunities: CatalogEntry[] = research.opportunities.map((opportunity) => ({ name: opportunity.service, min: 0, max: 0, text: '', note: '' }));
	for (const item of core) {
		if (!matchService(item.service, opportunities)) {
			findings.push({
				severity: 'low',
				category: 'research',
				where: t.item(item.name),
				issue: t.notInResearch(item.service),
				evidence: t.evidenceOpportunities(research.opportunities.map((opportunity) => opportunity.service).join(', ') || t.none),
				fix: t.fixNotInResearch,
			});
		}
	}

	if (normalizeName(proposal.client_name) !== normalizeName(research.client_name)) {
		findings.push({ severity: 'low', category: 'other', where: t.general, issue: t.clientName(proposal.client_name, research.client_name), evidence: '', fix: t.fixClientName });
	}

	return findings;
}

const CURRENCY_CODES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD', 'CAD', 'ARS', 'MXN', 'CLP', 'COP', 'BRL', 'UYU', 'PEN'];

/** The currency codes the knowledge mentions, most frequent first. */
export function knowledgeCurrencies(notes: KnowledgeNote[]): string[] {
	const counts = new Map<string, number>();
	const pattern = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'g');
	for (const note of notes) {
		for (const match of note.content.matchAll(pattern)) {
			const code = match[1] ?? '';
			counts.set(code, (counts.get(code) ?? 0) + 1);
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

const FOREIGN_DURATION: Record<ReportLanguage, RegExp> = {
	es: /\b(weeks?|days?|months?)\b/i,
	en: /\b(semanas?|d[ií]as?|mes(?:es)?)\b/i,
};

/** One finding as a line for a model: severity, category, where, issue, evidence and fix. */
export function formatFinding(finding: Finding): string {
	const evidence = finding.evidence.trim() ? ` Evidence: ${finding.evidence.trim()}` : '';
	return `- [${finding.severity}] [${finding.category}] ${finding.where}: ${finding.issue}${evidence} Fix: ${finding.fix}`;
}

export function countFindings(findings: Finding[]): Record<FindingSeverity, number> {
	const counts: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
	for (const finding of findings) {
		counts[finding.severity] += 1;
	}
	return counts;
}

const TEXT = {
	en: {
		item: (name: string) => `Item "${name}"`,
		scope: 'What we propose',
		timeline: 'Timeline',
		investment: 'Investment',
		nextSteps: 'Next steps',
		objectives: 'Objectives',
		general: 'Whole proposal',
		none: 'none',
		inverted: (min: string, max: string) => `The minimum price (${min}) is above the maximum (${max}).`,
		fixInverted: 'Correct the range.',
		notInKnowledge: (service: string) => `The service "${service}" is not in the knowledge, yet the item carries a price.`,
		evidenceCatalog: (names: string) => `Services with a price in the knowledge: ${names}.`,
		fixNotInKnowledge: 'Map the item to a service from the knowledge, or set its price to 0 and explain in the price note.',
		noPriceNoNote: (service: string) => `"${service}" has no price and no note saying why.`,
		fixNoPriceNoNote: 'Say in the price note why there is no price, for example "to quote after a call".',
		evidenceEntry: (name: string, text: string, note: string) => `Knowledge ("${note}"): ${name}, ${text}.`,
		nameDiffers: (service: string, name: string) => `The service is called "${service}"; the knowledge calls it "${name}".`,
		fixName: 'Use the name from the knowledge, so the price history stays consistent.',
		hasPrice: (service: string, text: string) => `"${service}" is left to quote, but the knowledge prices it at ${text}.`,
		fixHasPrice: 'Use the range from the knowledge.',
		below: (price: string, name: string, min: string) => `The minimum (${price}) is below the knowledge's minimum for "${name}" (${min}).`,
		above: (price: string, name: string, max: string) => `The maximum (${price}) is above the knowledge's maximum for "${name}" (${max}).`,
		fixRange: (text: string) => `Quote within ${text}.`,
		totals: (said: string, sum: string) => `The total written (${said}) is not the sum of the core items (${sum}).`,
		fixTotals: 'The note shows the sum; make the investment section match it.',
		currency: (currency: string) => `The proposal is in ${currency}, which the knowledge does not use.`,
		evidenceCurrency: (codes: string) => `Currencies in the knowledge: ${codes}.`,
		fixCurrency: 'Quote in the currency of the knowledge.',
		languageMismatch: (proposal: string, research: string) => `The proposal is in "${proposal}" and the research in "${research}".`,
		fixLanguage: 'Write the proposal in the language that was asked for.',
		durationLanguage: (text: string) => `Durations in the wrong language: ${text}.`,
		fixDuration: 'Write the durations in the language of the proposal.',
		noCore: 'There are no core items, so there is nothing to quote.',
		fixNoCore: 'Add at least one core item with a price from the knowledge.',
		noTimeline: 'The timeline is empty.',
		fixNoTimeline: 'Add the phases and what each one needs from the client.',
		noNextSteps: 'There are no next steps.',
		fixNoNextSteps: 'Say what happens if the client says yes.',
		noObjectives: 'There are no objectives.',
		fixNoObjectives: 'State what success looks like.',
		notInResearch: (service: string) => `"${service}" is not among the opportunities the research found.`,
		evidenceOpportunities: (list: string) => `Research opportunities: ${list}.`,
		fixNotInResearch: 'Check that the brief or the research justifies it, or say in the internal notes why it is there.',
		clientName: (proposal: string, research: string) => `The proposal names the client "${proposal}"; the research says "${research}".`,
		fixClientName: 'Use the name the business uses.',
	},
	es: {
		item: (name: string) => `Ítem "${name}"`,
		scope: 'Qué proponemos',
		timeline: 'Plazos',
		investment: 'Inversión',
		nextSteps: 'Próximos pasos',
		objectives: 'Objetivos',
		general: 'Toda la propuesta',
		none: 'ninguna',
		inverted: (min: string, max: string) => `El precio mínimo (${min}) es mayor que el máximo (${max}).`,
		fixInverted: 'Corregir el rango.',
		notInKnowledge: (service: string) => `El servicio "${service}" no está en la base de conocimiento, pero el ítem tiene precio.`,
		evidenceCatalog: (names: string) => `Servicios con precio en la base: ${names}.`,
		fixNotInKnowledge: 'Asignar el ítem a un servicio de la base, o dejar el precio en 0 y explicarlo en la nota de precio.',
		noPriceNoNote: (service: string) => `"${service}" no tiene precio ni una nota que diga por qué.`,
		fixNoPriceNoNote: 'Decir en la nota de precio por qué no hay precio, por ejemplo "a cotizar después de una llamada".',
		evidenceEntry: (name: string, text: string, note: string) => `Base de conocimiento ("${note}"): ${name}, ${text}.`,
		nameDiffers: (service: string, name: string) => `El servicio se llama "${service}"; la base lo llama "${name}".`,
		fixName: 'Usar el nombre de la base, para que el historial de precios quede consistente.',
		hasPrice: (service: string, text: string) => `"${service}" quedó a cotizar, pero la base lo cotiza en ${text}.`,
		fixHasPrice: 'Usar el rango de la base.',
		below: (price: string, name: string, min: string) => `El mínimo (${price}) está por debajo del mínimo de la base para "${name}" (${min}).`,
		above: (price: string, name: string, max: string) => `El máximo (${price}) está por encima del máximo de la base para "${name}" (${max}).`,
		fixRange: (text: string) => `Cotizar dentro de ${text}.`,
		totals: (said: string, sum: string) => `El total escrito (${said}) no es la suma de los ítems principales (${sum}).`,
		fixTotals: 'La nota muestra la suma; hacer que la sección de inversión coincida.',
		currency: (currency: string) => `La propuesta está en ${currency}, una moneda que la base no usa.`,
		evidenceCurrency: (codes: string) => `Monedas de la base: ${codes}.`,
		fixCurrency: 'Cotizar en la moneda de la base.',
		languageMismatch: (proposal: string, research: string) => `La propuesta está en "${proposal}" y la investigación en "${research}".`,
		fixLanguage: 'Escribir la propuesta en el idioma pedido.',
		durationLanguage: (text: string) => `Duraciones en otro idioma: ${text}.`,
		fixDuration: 'Escribir las duraciones en el idioma de la propuesta.',
		noCore: 'No hay ítems principales, así que no hay nada que cotizar.',
		fixNoCore: 'Agregar al menos un ítem principal con un precio de la base.',
		noTimeline: 'Los plazos están vacíos.',
		fixNoTimeline: 'Agregar las fases y qué necesita cada una del cliente.',
		noNextSteps: 'No hay próximos pasos.',
		fixNoNextSteps: 'Decir qué pasa si el cliente dice que sí.',
		noObjectives: 'No hay objetivos.',
		fixNoObjectives: 'Decir cómo se ve el éxito.',
		notInResearch: (service: string) => `"${service}" no está entre las oportunidades que encontró la investigación.`,
		evidenceOpportunities: (list: string) => `Oportunidades de la investigación: ${list}.`,
		fixNotInResearch: 'Confirmar que el brief o la investigación lo justifican, o decir en las notas internas por qué está.',
		clientName: (proposal: string, research: string) => `La propuesta llama al cliente "${proposal}"; la investigación dice "${research}".`,
		fixClientName: 'Usar el nombre que usa el negocio.',
	},
} as const;
