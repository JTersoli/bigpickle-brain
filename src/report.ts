import type { ResearchReport } from './agents/research.ts';
import { describeUsage, type UsageTotals } from './pricing.ts';

export interface ReportMeta {
	date: string;
	model: string;
	provider: string;
	usage: UsageTotals;
	cost: number | null;
	durationMs: number;
	steps: number;
	fetches: number;
	brief: string;
}

const LABELS = {
	en: {
		title: 'research',
		summary: 'Summary',
		business: 'The business',
		industry: 'Industry',
		location: 'Location',
		size: 'Size',
		segment: 'Segment',
		presence: 'Digital presence',
		channel: 'Channel',
		status: 'Status',
		notes: 'Notes',
		problems: 'Problems found',
		evidence: 'Evidence',
		impact: 'Impact',
		competitors: 'Competitors',
		opportunities: 'Opportunities for the agency',
		service: 'Service',
		why: 'Why',
		price: 'Price',
		priority: 'Priority',
		questions: 'Questions for the client',
		sources: 'Sources',
		confidence: 'Confidence',
		brief: 'Brief',
		run: 'Run',
		none: 'None.',
		model: 'Model',
		stepsLine: 'Steps',
		fetched: 'pages fetched',
		duration: 'duration',
		tokens: 'Tokens',
		found: 'found',
		not_found: 'not found',
		unknown: 'unknown',
		high: 'high',
		medium: 'medium',
		low: 'low',
		smb: 'small business',
		growth: 'growth',
	},
	es: {
		title: 'investigación',
		summary: 'Resumen',
		business: 'El negocio',
		industry: 'Rubro',
		location: 'Ubicación',
		size: 'Tamaño',
		segment: 'Segmento',
		presence: 'Presencia digital',
		channel: 'Canal',
		status: 'Estado',
		notes: 'Notas',
		problems: 'Problemas detectados',
		evidence: 'Evidencia',
		impact: 'Impacto',
		competitors: 'Competencia',
		opportunities: 'Oportunidades para la agencia',
		service: 'Servicio',
		why: 'Por qué',
		price: 'Precio',
		priority: 'Prioridad',
		questions: 'Preguntas para el cliente',
		sources: 'Fuentes',
		confidence: 'Confianza',
		brief: 'Brief',
		run: 'Corrida',
		none: 'Nada.',
		model: 'Modelo',
		stepsLine: 'Pasos',
		fetched: 'páginas leídas',
		duration: 'duración',
		tokens: 'Tokens',
		found: 'sí',
		not_found: 'no',
		unknown: 'sin verificar',
		high: 'alta',
		medium: 'media',
		low: 'baja',
		smb: 'pyme',
		growth: 'en crecimiento',
	},
} as const;

const CHANNELS: Record<ResearchReport['digital_presence'][number]['channel'], string> = {
	website: 'Website',
	google_business: 'Google Business Profile',
	instagram: 'Instagram',
	facebook: 'Facebook',
	tiktok: 'TikTok',
	linkedin: 'LinkedIn',
	online_ordering: 'Online ordering',
	ads: 'Ads',
	reviews: 'Reviews',
	email_newsletter: 'Email / newsletter',
	other: 'Other',
};

/** The report as an Obsidian-friendly Markdown note. Headings follow the report's language. */
export function renderResearchReport(report: ResearchReport, meta: ReportMeta): string {
	const t = LABELS[report.language];
	const lines: string[] = [];

	lines.push('---');
	lines.push('type: research');
	lines.push(`client: "${yaml(report.client_name)}"`);
	lines.push(`website: "${yaml(report.website)}"`);
	lines.push(`date: ${meta.date}`);
	lines.push(`model: "${yaml(meta.model)}"`);
	lines.push(`confidence: ${report.confidence}`);
	lines.push(`updated: ${meta.date}`);
	lines.push('---');
	lines.push('');
	lines.push(`# ${report.client_name}: ${t.title}`);
	lines.push('');
	lines.push(`## ${t.summary}`);
	lines.push('');
	lines.push(report.summary.trim());
	lines.push('');
	lines.push(`## ${t.business}`);
	lines.push('');
	lines.push(`- **${t.industry}:** ${report.business.industry}`);
	lines.push(`- **${t.location}:** ${report.business.location}`);
	lines.push(`- **${t.size}:** ${report.business.size_estimate}`);
	lines.push(`- **${t.segment}:** ${t[report.business.segment]}`);
	if (report.website) {
		lines.push(`- **Web:** ${report.website}`);
	}
	lines.push('');
	lines.push(`## ${t.presence}`);
	lines.push('');
	if (report.digital_presence.length === 0) {
		lines.push(t.none);
	} else {
		lines.push(`| ${t.channel} | ${t.status} | ${t.notes} |`);
		lines.push('|---|---|---|');
		for (const item of report.digital_presence) {
			lines.push(`| ${CHANNELS[item.channel]} | ${t[item.status]} | ${cell(item.notes)} |`);
		}
	}
	lines.push('');
	lines.push(`## ${t.problems}`);
	lines.push('');
	if (report.problems.length === 0) {
		lines.push(t.none);
	}
	report.problems.forEach((item, index) => {
		lines.push(`${index + 1}. **${item.problem}** (${t.impact.toLowerCase()}: ${t[item.impact]}). ${t.evidence}: ${item.evidence}`);
	});
	lines.push('');
	lines.push(`## ${t.competitors}`);
	lines.push('');
	if (report.competitors.length === 0) {
		lines.push(t.none);
	}
	for (const item of report.competitors) {
		const link = item.url ? ` (${item.url})` : '';
		lines.push(`- **${item.name}**${link}: ${item.notes}`);
	}
	lines.push('');
	lines.push(`## ${t.opportunities}`);
	lines.push('');
	if (report.opportunities.length === 0) {
		lines.push(t.none);
	} else {
		lines.push(`| ${t.service} | ${t.why} | ${t.price} | ${t.priority} |`);
		lines.push('|---|---|---|---|');
		for (const item of report.opportunities) {
			lines.push(`| ${cell(item.service)} | ${cell(item.why)} | ${cell(item.price_range)} | ${t[item.priority]} |`);
		}
	}
	lines.push('');
	lines.push(`## ${t.questions}`);
	lines.push('');
	if (report.questions_for_client.length === 0) {
		lines.push(t.none);
	}
	report.questions_for_client.forEach((question, index) => {
		lines.push(`${index + 1}. ${question}`);
	});
	lines.push('');
	lines.push(`## ${t.sources}`);
	lines.push('');
	if (report.sources.length === 0) {
		lines.push(t.none);
	}
	for (const source of report.sources) {
		lines.push(`- ${source.url}: ${source.used_for}`);
	}
	lines.push('');
	lines.push(`## ${t.confidence}`);
	lines.push('');
	lines.push(`**${t[report.confidence]}.** ${report.confidence_notes}`);
	lines.push('');
	lines.push(`## ${t.brief}`);
	lines.push('');
	for (const line of meta.brief.trim().split(/\r?\n/)) {
		lines.push(`> ${line}`);
	}
	lines.push('');
	lines.push(`## ${t.run}`);
	lines.push('');
	lines.push(`- ${t.model}: ${meta.provider.includes(meta.model) ? meta.provider : `${meta.model} (${meta.provider})`}`);
	lines.push(`- ${t.stepsLine}: ${meta.steps}, ${t.fetched}: ${meta.fetches}, ${t.duration}: ${(meta.durationMs / 1000).toFixed(0)} s`);
	lines.push(`- ${t.tokens}: ${describeUsage(meta.usage, meta.cost)}`);
	lines.push('');

	return lines.join('\n');
}

/** `2026-09-30 Research Client.md`, safe for any file system and for Obsidian links. */
export function reportFileName(date: string, client: string, language: ResearchReport['language']): string {
	const word = language === 'es' ? 'Investigación' : 'Research';
	const safeClient = client
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
		.trim();
	return `${date} ${word} ${safeClient || 'client'}.md`;
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();
}

function yaml(text: string): string {
	return text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}
