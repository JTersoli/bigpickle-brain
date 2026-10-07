import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchReport } from '../agents/research.ts';
import { parsePriceCatalog, runChecks } from '../checks.ts';
import { describeProvider, type BrainConfig } from '../config.ts';
import { AgentRunError, type LoopDeps, type ToolCallRecord } from '../loop.ts';
import { emptyUsage, estimateCost, type UsageTotals } from '../pricing.ts';
import { proposalTotals } from '../proposalReport.ts';
import { runReview } from '../review.ts';
import { type ReviewFinding } from '../reviewReport.ts';
import { runResearch } from '../run.ts';
import { loadKnowledge } from '../tools/knowledge.ts';
import { ClientMemory, isoDate } from '../tools/memory.ts';
import { runFolder } from '../trace.ts';
import { loadResearchCases, loadReviewCases, type ReviewCase, type ReviewExpectation, type ResearchCase } from './cases.ts';
import { renderEvalReport } from './report.ts';
import { scoreResearch, scoreReview, type ResearchScore, type ReviewScore } from './score.ts';

export type EvalSuite = 'review' | 'research';

export interface EvalOptions {
	/** Model and provider settings. The data folders are replaced per case, so nothing touches the real notes. */
	config: BrainConfig;
	/** The folder with `knowledge/`, `review/` and `research/`. */
	casesDir: string;
	suites: EvalSuite[];
	/** Runs only the cases whose name contains this text. */
	only?: string;
	/** Review cases: run the code checks alone, without the agent. Research cases need a model and are skipped. */
	checksOnly?: boolean;
	log?: (line: string) => void;
	/** Replaces the real API client, for tests. */
	deps?: LoopDeps;
	/** Replaces the fetch built from the case's pages, for tests. */
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export interface ReviewCaseResult {
	name: string;
	description: string;
	expected: ReviewExpectation;
	score: ReviewScore;
	/** The code's findings and the agent's, as the review merged them. */
	findings: ReviewFinding[];
	durationMs: number;
	usage: UsageTotals;
	cost: number | null;
	runDir?: string;
	reviewPath?: string;
	error?: string;
}

export interface ResearchCaseResult {
	name: string;
	description: string;
	score: ResearchScore;
	report: ResearchReport | null;
	durationMs: number;
	usage: UsageTotals;
	cost: number | null;
	runDir?: string;
	reportPath?: string;
	memoryPath?: string;
	error?: string;
}

export interface EvalOutcome {
	date: string;
	model: string;
	provider: string;
	checksOnly: boolean;
	review: ReviewCaseResult[];
	research: ResearchCaseResult[];
	durationMs: number;
	usage: UsageTotals;
	cost: number | null;
	/** Where the results, the report and every case's notes and traces were written. */
	runDir: string;
	reportPath: string;
}

/**
 * Runs the eval cases: proposals with planted errors through the checks and the review agent, and
 * briefs with injected pages through the research agent. Each case gets its own data folders under
 * the run folder, so the agency's real notes are never read or written.
 */
export async function runEvals(options: EvalOptions): Promise<EvalOutcome> {
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();
	const checksOnly = options.checksOnly ?? false;
	const casesDir = path.resolve(options.casesDir);
	const knowledgeDir = path.join(casesDir, 'knowledge');
	const runDir = runFolder(options.config.runsDir, started, 'evals');
	await mkdir(runDir, { recursive: true });

	const notes = await loadKnowledge(knowledgeDir);
	if (notes.length === 0) {
		log(`warning: no knowledge notes in ${knowledgeDir}; prices and services cannot be checked`);
	}
	const catalog = parsePriceCatalog(notes);
	const filter = (name: string) => !options.only || name.toLowerCase().includes(options.only.toLowerCase());

	const review: ReviewCaseResult[] = [];
	if (options.suites.includes('review')) {
		const cases = (await loadReviewCases(casesDir)).filter((entry) => filter(entry.name));
		log(`review evals: ${cases.length} case(s)${checksOnly ? ', checks only' : ''}`);
		for (const entry of cases) {
			log(`case: ${entry.name}`);
			review.push(await runReviewCase(entry, { ...options, checksOnly, now, log, knowledgeDir, runDir }));
		}
	}

	const research: ResearchCaseResult[] = [];
	if (options.suites.includes('research')) {
		if (checksOnly) {
			log('research evals: skipped, they need a model');
		} else {
			const cases = (await loadResearchCases(casesDir)).filter((entry) => filter(entry.name));
			log(`research evals: ${cases.length} case(s)`);
			for (const entry of cases) {
				log(`case: ${entry.name}`);
				research.push(await runResearchCase(entry, { ...options, now, log, knowledgeDir, runDir }, catalog));
			}
		}
	}

	const usage = emptyUsage();
	let cost: number | null = 0;
	for (const result of [...review, ...research]) {
		usage.requests += result.usage.requests;
		usage.inputTokens += result.usage.inputTokens;
		usage.outputTokens += result.usage.outputTokens;
		usage.cacheReadTokens += result.usage.cacheReadTokens;
		usage.cacheWriteTokens += result.usage.cacheWriteTokens;
		cost = cost === null || result.cost === null ? null : cost + result.cost;
	}

	const outcome: EvalOutcome = {
		date: isoDate(started),
		model: options.config.model,
		provider: describeProvider(options.config),
		checksOnly,
		review,
		research,
		durationMs: now().getTime() - started.getTime(),
		usage,
		cost,
		runDir,
		reportPath: path.join(runDir, 'report.md'),
	};
	await writeFile(path.join(runDir, 'results.json'), JSON.stringify(outcome, null, '\t'), 'utf8');
	await writeFile(outcome.reportPath, renderEvalReport(outcome), 'utf8');
	return outcome;
}

interface CaseContext extends EvalOptions {
	now: () => Date;
	log: (line: string) => void;
	knowledgeDir: string;
	runDir: string;
}

/** The configuration for one case: the model settings, and data folders of its own under the run folder. */
function caseConfig(context: CaseContext, name: string): BrainConfig {
	const dir = path.join(context.runDir, 'cases', name);
	return {
		...context.config,
		knowledgeDir: context.knowledgeDir,
		clientsDir: path.join(dir, 'clients'),
		reportsDir: path.join(dir, 'reports'),
		proposalsDir: path.join(dir, 'proposals'),
		reviewsDir: path.join(dir, 'reviews'),
		runsDir: path.join(dir, 'runs'),
	};
}

async function runReviewCase(entry: ReviewCase, context: CaseContext): Promise<ReviewCaseResult> {
	const config = caseConfig(context, entry.name);
	const started = context.now();
	await seedClientNotes(entry, config.clientsDir, isoDate(started));
	await seedPastProposals(entry, config.proposalsDir);

	const notes = await loadKnowledge(config.knowledgeDir);
	const checks: ReviewFinding[] = runChecks({ proposal: entry.proposal, research: entry.report, notes, totals: proposalTotals(entry.proposal) }).map((finding) => ({ ...finding, source: 'code' as const }));
	const base = { name: entry.name, description: entry.description, expected: entry.expected };

	if (context.checksOnly) {
		const score = scoreReview(entry.expected, checks, null, 'checks');
		return { ...base, score, findings: checks, durationMs: context.now().getTime() - started.getTime(), usage: emptyUsage(), cost: 0 };
	}

	try {
		const outcome = await runReview({
			brief: entry.brief,
			research: entry.report,
			proposal: entry.proposal,
			clientName: entry.proposal.client_name,
			config,
			log: context.log,
			deps: context.deps,
			now: context.now,
		});
		const score = scoreReview(entry.expected, outcome.findings, outcome.verdict, 'full');
		return {
			...base,
			score,
			findings: outcome.findings,
			durationMs: context.now().getTime() - started.getTime(),
			usage: outcome.result.usage,
			cost: outcome.cost,
			runDir: outcome.runDir,
			reviewPath: outcome.reviewPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.log(`case ${entry.name} failed: ${message}`);
		const usage = error instanceof AgentRunError ? error.usage : emptyUsage();
		const score = scoreReview(entry.expected, checks, null, 'checks');
		return { ...base, score: { ...score, mode: 'full', pass: false }, findings: checks, durationMs: context.now().getTime() - started.getTime(), usage, cost: estimateCost(context.config.model, usage), error: message };
	}
}

async function runResearchCase(entry: ResearchCase, context: CaseContext, catalog: ReturnType<typeof parsePriceCatalog>): Promise<ResearchCaseResult> {
	const config = caseConfig(context, entry.name);
	const started = context.now();
	const fetchImpl = context.fetchImpl ?? pagesFetch(entry.pages);
	const memory = new ClientMemory(config.clientsDir);
	const base = { name: entry.name, description: entry.description };

	let report: ResearchReport | null = null;
	let toolCalls: ToolCallRecord[] = [];
	let usage: UsageTotals = emptyUsage();
	let cost: number | null = null;
	let error: string | undefined;
	let runDir: string | undefined;
	let reportPath: string | undefined;
	let memoryPath: string | undefined;
	let clientName = entry.client ?? '';
	try {
		const outcome = await runResearch({ brief: entry.brief, clientName: entry.client, language: entry.language, config, log: context.log, deps: context.deps, now: context.now, fetchImpl });
		report = outcome.report;
		toolCalls = outcome.result.steps.flatMap((step) => step.toolCalls);
		usage = outcome.result.usage;
		cost = outcome.cost;
		runDir = outcome.runDir;
		reportPath = outcome.reportPath;
		memoryPath = outcome.memoryPath;
		clientName = clientName || outcome.report.client_name;
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
		context.log(`case ${entry.name} failed: ${error}`);
		if (caught instanceof AgentRunError) {
			toolCalls = caught.steps.flatMap((step) => step.toolCalls);
			usage = caught.usage;
			cost = estimateCost(context.config.model, usage);
		}
	}

	const memoryText = clientName ? ((await memory.read(clientName)) ?? '') : '';
	const score = scoreResearch({ expected: entry.expected, report, memory: memoryText, toolCalls, catalog });
	return { ...base, score, report, durationMs: context.now().getTime() - started.getTime(), usage, cost, runDir, reportPath, memoryPath, error };
}

/** The client's note as the agents would have left it, so `recall_client` finds the planted history. */
async function seedClientNotes(entry: ReviewCase, clientsDir: string, today: string): Promise<void> {
	if (entry.clientNotes.length === 0) {
		return;
	}
	const memory = new ClientMemory(clientsDir);
	const name = entry.proposal.client_name;
	const first = /\d{4}-\d{2}-\d{2}/.exec(entry.clientNotes[0] ?? '')?.[0] ?? today;
	const lines = entry.clientNotes.map((line) => (line.trim().startsWith('-') ? line.trim() : `- ${line.trim()}`));
	const text = ['---', 'type: client', `name: "${name.replace(/"/g, "'")}"`, `created: ${first}`, `updated: ${first}`, '---', '', `# ${name}`, '', '## Notes', '', ...lines, ''].join('\n');
	await mkdir(clientsDir, { recursive: true });
	await writeFile(memory.pathFor(name), text, 'utf8');
}

/** Past proposals as notes with the frontmatter `past_proposals` reads. */
async function seedPastProposals(entry: ReviewCase, proposalsDir: string): Promise<void> {
	if (entry.pastProposals.length === 0) {
		return;
	}
	await mkdir(proposalsDir, { recursive: true });
	for (const [index, seed] of entry.pastProposals.entries()) {
		const safe = seed.client.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
		const file = path.join(proposalsDir, `${seed.date} Proposal ${safe}${index > 0 ? ` ${index + 1}` : ''}.md`);
		const text = [
			'---',
			'type: proposal',
			`client: "${seed.client.replace(/"/g, "'")}"`,
			`date: ${seed.date}`,
			`language: ${seed.language}`,
			`status: ${seed.status}`,
			`currency: ${seed.currency}`,
			`total_min: ${seed.total_min}`,
			`total_max: ${seed.total_max}`,
			`services: "${seed.services.replace(/"/g, "'")}"`,
			'---',
			'',
			`# ${seed.client}: proposal of ${seed.date}`,
			'',
			'Seeded by the evals as price history.',
			'',
		].join('\n');
		await writeFile(file, text, 'utf8');
	}
}

/** A fetch that serves the case's pages and answers 404 to everything else, so no eval touches the network. */
export function pagesFetch(pages: Record<string, string>): typeof fetch {
	const byUrl = new Map<string, string>();
	for (const [url, html] of Object.entries(pages)) {
		byUrl.set(canonical(url), html);
	}
	const impl = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const html = byUrl.get(canonical(url));
		if (html === undefined) {
			return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
		}
		return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
	};
	return impl as typeof fetch;
}

function canonical(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.toString().replace(/\/$/, '');
	} catch {
		return url;
	}
}
