import type { Review, Verdict } from './agents/review.ts';
import { countFindings, type Finding, type FindingSeverity } from './checks.ts';
import { describeUsage, type UsageTotals } from './pricing.ts';
import { safeNamePart } from './report.ts';

/** A finding with where it came from: the code's checks or the review agent. */
export interface ReviewFinding extends Finding {
	source: 'code' | 'model';
}

export interface ReviewMeta {
	date: string;
	model: string;
	provider: string;
	usage: UsageTotals;
	cost: number | null;
	durationMs: number;
	steps: number;
	/** Note names, without the extension, to link them. */
	proposalNoteName?: string;
	researchNoteName?: string;
	brief: string;
}

const RANK: Record<Verdict, number> = { approve: 0, revise: 1, reject: 2 };
const SEVERITY_ORDER: FindingSeverity[] = ['high', 'medium', 'low'];

/** The code's findings first, then the model's, most serious first within each. */
export function mergeFindings(checks: Finding[], review: Review): ReviewFinding[] {
	const all: ReviewFinding[] = [...checks.map((finding) => ({ ...finding, source: 'code' as const })), ...review.findings.map((finding) => ({ ...finding, source: 'model' as const }))];
	return all.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export interface FinalVerdict {
	verdict: Verdict;
	/** True when the code raised the model's verdict because of what the checks or the findings say. */
	overridden: boolean;
}

/**
 * The verdict the note shows. The model's word counts, but the code has the last one: a high finding
 * from anyone means at least "revise", and a medium one rules out "approve".
 */
export function finalVerdict(review: Review, findings: ReviewFinding[]): FinalVerdict {
	const counts = countFindings(findings);
	let floor: Verdict = 'approve';
	if (counts.high > 0 || counts.medium > 0) {
		floor = 'revise';
	}
	const verdict = RANK[review.verdict] >= RANK[floor] ? review.verdict : floor;
	return { verdict, overridden: verdict !== review.verdict };
}

const LABELS = {
	en: {
		title: 'review of the proposal',
		verdict: 'Verdict',
		verdicts: { approve: 'approve', revise: 'revise', reject: 'reject' } as Record<Verdict, string>,
		overridden: (said: string, high: number, medium: number) =>
			`The model said "${said}", but the findings include ${high} high and ${medium} medium, so the verdict is what the rules give.`,
		findings: 'Findings',
		severities: { high: 'high', medium: 'medium', low: 'low' } as Record<FindingSeverity, string>,
		sources: { code: 'checks', model: 'reviewer' },
		evidence: 'Evidence',
		fix: 'Fix',
		noFindings: 'Nothing to change.',
		strengths: 'What works',
		checked: 'What was checked and is fine',
		none: 'None.',
		proposal: 'Proposal',
		research: 'Research',
		brief: 'Brief',
		model: 'Model',
		stepsLine: 'Steps',
		durationLine: 'duration',
		tokens: 'Tokens',
		counts: (high: number, medium: number, low: number) => `${high} high, ${medium} medium, ${low} low`,
	},
	es: {
		title: 'revisión de la propuesta',
		verdict: 'Veredicto',
		verdicts: { approve: 'aprobar', revise: 'revisar', reject: 'rechazar' } as Record<Verdict, string>,
		overridden: (said: string, high: number, medium: number) =>
			`El modelo dijo "${said}", pero los hallazgos incluyen ${high} de gravedad alta y ${medium} media, así que el veredicto es el que dan las reglas.`,
		findings: 'Hallazgos',
		severities: { high: 'alta', medium: 'media', low: 'baja' } as Record<FindingSeverity, string>,
		sources: { code: 'chequeos', model: 'revisor' },
		evidence: 'Evidencia',
		fix: 'Cambio',
		noFindings: 'Nada que cambiar.',
		strengths: 'Lo que está bien',
		checked: 'Qué se revisó y está bien',
		none: 'Nada.',
		proposal: 'Propuesta',
		research: 'Investigación',
		brief: 'Brief',
		model: 'Modelo',
		stepsLine: 'Pasos',
		durationLine: 'duración',
		tokens: 'Tokens',
		counts: (high: number, medium: number, low: number) => `${high} alta, ${medium} media, ${low} baja`,
	},
} as const;

/** The review as an Obsidian-friendly Markdown note: verdict first, then the findings most serious first. */
export function renderReview(review: Review, findings: ReviewFinding[], verdict: FinalVerdict, meta: ReviewMeta): string {
	const t = LABELS[review.language];
	const counts = countFindings(findings);
	const lines: string[] = [];

	lines.push('---');
	lines.push('type: review');
	lines.push(`client: "${yaml(review.client_name)}"`);
	lines.push(`date: ${meta.date}`);
	lines.push(`language: ${review.language}`);
	lines.push(`verdict: ${verdict.verdict}`);
	lines.push(`findings: ${findings.length}`);
	lines.push(`high: ${counts.high}`);
	lines.push(`proposal: "${meta.proposalNoteName ? yaml(`[[${meta.proposalNoteName}]]`) : ''}"`);
	lines.push(`research: "${meta.researchNoteName ? yaml(`[[${meta.researchNoteName}]]`) : ''}"`);
	lines.push(`model: "${yaml(meta.model)}"`);
	lines.push(`updated: ${meta.date}`);
	lines.push('---');
	lines.push('');
	lines.push(`# ${review.client_name}: ${t.title}`);
	lines.push('');
	lines.push(`**${t.verdict}: ${t.verdicts[verdict.verdict]}.** ${review.summary.trim()}`);
	lines.push('');
	if (verdict.overridden) {
		lines.push(t.overridden(t.verdicts[review.verdict], counts.high, counts.medium));
		lines.push('');
	}
	lines.push(`## ${t.findings} (${t.counts(counts.high, counts.medium, counts.low)})`);
	lines.push('');
	if (findings.length === 0) {
		lines.push(t.noFindings);
	}
	findings.forEach((finding, index) => {
		const evidence = finding.evidence.trim() ? ` ${t.evidence}: ${oneLine(finding.evidence)}` : '';
		lines.push(`${index + 1}. **[${t.severities[finding.severity]}] ${oneLine(finding.where)}:** ${oneLine(finding.issue)}${evidence} ${t.fix}: ${oneLine(finding.fix)} *(${t.sources[finding.source]})*`);
	});
	lines.push('');
	lines.push(`## ${t.strengths}`);
	lines.push('');
	pushList(lines, review.strengths, t.none);
	lines.push('');
	lines.push(`## ${t.checked}`);
	lines.push('');
	pushList(lines, review.checked, t.none);
	lines.push('');
	lines.push('---');
	lines.push('');
	if (meta.proposalNoteName) {
		lines.push(`- ${t.proposal}: [[${meta.proposalNoteName}]]`);
	}
	if (meta.researchNoteName) {
		lines.push(`- ${t.research}: [[${meta.researchNoteName}]]`);
	}
	if (meta.brief.trim()) {
		lines.push(`- ${t.brief}: ${oneLine(meta.brief)}`);
	}
	lines.push(`- ${t.model}: ${meta.provider.includes(meta.model) ? meta.provider : `${meta.model} (${meta.provider})`}`);
	lines.push(`- ${t.stepsLine}: ${meta.steps}, ${t.durationLine}: ${(meta.durationMs / 1000).toFixed(0)} s`);
	lines.push(`- ${t.tokens}: ${describeUsage(meta.usage, meta.cost)}`);
	lines.push('');

	return lines.join('\n');
}

/** `2026-10-07 Review Client.md` */
export function reviewFileName(date: string, client: string, language: Review['language']): string {
	const word = language === 'es' ? 'Revisión' : 'Review';
	return `${date} ${word} ${safeNamePart(client)}.md`;
}

/** The verdict and the counts in one line, for the console and the client memory. */
export function describeVerdict(verdict: Verdict, findings: Finding[]): string {
	const counts = countFindings(findings);
	return `${verdict} (${counts.high} high, ${counts.medium} medium, ${counts.low} low)`;
}

function pushList(lines: string[], items: string[], none: string): void {
	if (items.length === 0) {
		lines.push(none);
		return;
	}
	for (const item of items) {
		lines.push(`- ${oneLine(item)}`);
	}
}

function oneLine(text: string): string {
	return text.replace(/\s*\n+\s*/g, ' ').trim();
}

function yaml(text: string): string {
	return text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}
