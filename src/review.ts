import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Proposal } from './agents/proposal.ts';
import type { ReportLanguage, ResearchReport } from './agents/research.ts';
import { buildReviewMessage, createReviewAgent, type Review, type Verdict } from './agents/review.ts';
import { countFindings, runChecks, type Finding } from './checks.ts';
import { describeProvider, type BrainConfig } from './config.ts';
import { setFrontmatterValue } from './frontmatter.ts';
import { AgentRunError, runAgent, type LoopDeps, type RunResult } from './loop.ts';
import { estimateCost } from './pricing.ts';
import { proposalTotals } from './proposalReport.ts';
import { createLoopDeps } from './provider.ts';
import { describeVerdict, finalVerdict, mergeFindings, renderReview, reviewFileName, type ReviewFinding } from './reviewReport.ts';
import { loadKnowledge, renderKnowledge } from './tools/knowledge.ts';
import { ClientMemory, createMemoryTools, isoDate } from './tools/memory.ts';
import { createPastProposalsTool, ProposalStore } from './tools/proposals.ts';
import { runFolder, writeTrace } from './trace.ts';

export interface ReviewRunOptions {
	brief: string;
	research: ResearchReport;
	proposal: Proposal;
	/** Path of the proposal note, to record the verdict in its frontmatter. */
	proposalPath?: string;
	/** Note names, without the extension, to link them from the review. */
	proposalNoteName?: string;
	researchNoteName?: string;
	clientName?: string;
	language?: ReportLanguage;
	/** Which version of the proposal this reviews: 1 for the first draft. */
	version?: number;
	config: BrainConfig;
	log?: (line: string) => void;
	/** Replaces the real API client, for tests. */
	deps?: LoopDeps;
	now?: () => Date;
}

export interface ReviewRunOutcome {
	review: Review;
	/** The verdict the note shows: the model's, raised by the code when the findings demand it. */
	verdict: Verdict;
	/** The code's findings and the model's, most serious first. */
	findings: ReviewFinding[];
	/** The code's findings alone, as the model received them. */
	checks: Finding[];
	reviewPath: string;
	memoryPath: string;
	runDir: string;
	result: RunResult<Review>;
	cost: number | null;
}

/**
 * One review run: the code checks the proposal against the knowledge, the agent judges the rest,
 * and the harness writes the review note, marks the proposal note and records the verdict in the
 * client memory.
 */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunOutcome> {
	const { config } = options;
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();
	const today = isoDate(started);
	const version = options.version ?? 1;

	const notes = await loadKnowledge(config.knowledgeDir);
	if (notes.length === 0) {
		log(`warning: no knowledge notes in ${config.knowledgeDir}, so prices and services cannot be checked`);
	}
	const checks = runChecks({ proposal: options.proposal, research: options.research, notes, totals: proposalTotals(options.proposal) });
	const counts = countFindings(checks);
	log(`checks: ${checks.length} finding(s) (${counts.high} high, ${counts.medium} medium, ${counts.low} low)`);

	const memory = new ClientMemory(config.clientsDir);
	const store = new ProposalStore(config.proposalsDir);
	const [recall] = createMemoryTools(memory, now);
	const tools = recall ? [recall, createPastProposalsTool(store)] : [createPastProposalsTool(store)];
	const agent = createReviewAgent({ knowledge: renderKnowledge(notes), tools });
	const deps = options.deps ?? createLoopDeps(config);
	const clientName = options.clientName?.trim() || options.proposal.client_name.trim() || 'client';
	const message = buildReviewMessage({ brief: options.brief, research: options.research, proposal: options.proposal, checks, clientName, language: options.language, today });
	const runDir = runFolder(config.runsDir, started, ClientMemory.slug(clientName), version > 1 ? `review-v${version}` : 'review');
	const stamp = { kind: 'review' as const, client: clientName, startedAt: started.toISOString(), model: config.model, provider: describeProvider(config), revision: version - 1 };

	let result: RunResult<Review>;
	try {
		result = await runAgent(deps, agent, message, { maxSteps: config.maxSteps, log, now });
	} catch (error) {
		if (error instanceof AgentRunError) {
			await writeTrace(runDir, { ...stamp, steps: error.steps, messages: error.messages, usage: error.usage, durationMs: now().getTime() - started.getTime(), brief: options.brief, checks, failure: error.reason, error: error.message });
		}
		throw error;
	}

	const review = result.output;
	const cost = estimateCost(result.model, result.usage);
	const findings = mergeFindings(checks, review);
	const verdict = finalVerdict(review, findings);
	if (verdict.overridden) {
		log(`verdict raised from "${review.verdict}" to "${verdict.verdict}" because of the findings`);
	}
	const fileName = reviewFileName(today, clientName, review.language);
	const reviewPath = path.join(config.reviewsDir, fileName);
	const markdown = renderReview(review, findings, verdict, {
		date: today,
		model: result.model,
		provider: describeProvider(config),
		usage: result.usage,
		cost,
		durationMs: result.durationMs,
		steps: result.steps.length,
		proposalNoteName: options.proposalNoteName,
		researchNoteName: options.researchNoteName,
		brief: options.brief,
	});
	await mkdir(config.reviewsDir, { recursive: true });
	await writeFile(reviewPath, markdown, 'utf8');

	if (options.proposalPath) {
		await markProposal(options.proposalPath, fileName.slice(0, -3), verdict.verdict, log);
	}

	const source = version > 1 ? `review v${version}` : 'review';
	const memoryPath = await memory.append(clientName, reviewFacts(verdict.verdict, findings, fileName.slice(0, -3)), source, started);
	await writeTrace(runDir, {
		...stamp,
		steps: result.steps,
		messages: result.messages,
		usage: result.usage,
		durationMs: result.durationMs,
		model: result.model,
		cost,
		brief: options.brief,
		reportPath: reviewPath,
		report: review,
		checks,
		findings,
		verdict: verdict.verdict,
		proposal: options.proposal,
		proposalNoteName: options.proposalNoteName,
		research: options.research,
		researchNoteName: options.researchNoteName,
	});

	return { review, verdict: verdict.verdict, findings, checks, reviewPath, memoryPath, runDir, result, cost };
}

/** Records the verdict and the link to the review in the proposal note's frontmatter. */
async function markProposal(proposalPath: string, reviewNoteName: string, verdict: Verdict, log: (line: string) => void): Promise<void> {
	let text: string;
	try {
		text = await readFile(proposalPath, 'utf8');
	} catch {
		log(`warning: could not read ${proposalPath} to record the verdict`);
		return;
	}
	text = setFrontmatterValue(text, 'review', `"[[${reviewNoteName.replace(/"/g, "'")}]]"`);
	text = setFrontmatterValue(text, 'verdict', verdict);
	await writeFile(proposalPath, text, 'utf8');
}

/** What the client's note keeps about this review, written by the harness: the verdict and the serious findings. */
export function reviewFacts(verdict: Verdict, findings: Finding[], noteName: string): string[] {
	const facts = [`Review: [[${noteName}]]`, `Verdict: ${describeVerdict(verdict, findings)}`];
	for (const finding of findings.filter((entry) => entry.severity === 'high').slice(0, 3)) {
		facts.push(`Finding (high): ${finding.where}: ${finding.issue}`);
	}
	return facts;
}
