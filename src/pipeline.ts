import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReportLanguage } from './agents/research.ts';
import { countFindings } from './checks.ts';
import type { BrainConfig } from './config.ts';
import type { LoopDeps } from './loop.ts';
import { emptyUsage, type UsageTotals } from './pricing.ts';
import { runProposal, type ProposalRunOutcome } from './propose.ts';
import { runReview, type ReviewRunOutcome } from './review.ts';
import { runResearch, type ResearchRunOutcome } from './run.ts';
import { ClientMemory } from './tools/memory.ts';
import { runFolder } from './trace.ts';

export interface PipelineOptions {
	brief: string;
	clientName?: string;
	language?: ReportLanguage;
	config: BrainConfig;
	/** Overrides the configured number of rewrites. */
	maxRevisions?: number;
	log?: (line: string) => void;
	deps?: LoopDeps;
	now?: () => Date;
}

/** A proposal and the review it got. The pipeline keeps one per version. */
export interface PipelineAttempt {
	proposal: ProposalRunOutcome;
	review: ReviewRunOutcome;
}

export interface PipelineOutcome {
	research: ResearchRunOutcome;
	/** The last proposal written. */
	proposal: ProposalRunOutcome;
	/** The review of the last proposal. */
	review: ReviewRunOutcome;
	/** Every proposal and its review, first draft first. The last one is the outcome's. */
	attempts: PipelineAttempt[];
	usage: UsageTotals;
	cost: number | null;
	durationMs: number;
	runDir: string;
}

/**
 * The orchestrator: research, then the proposal written from that research, then the review of
 * that proposal; when the reviewer does not approve and rewrites are allowed, the proposal agent
 * gets the review back and the result is reviewed again. Plain code, no model in between: each
 * stage is an agent, the order and the hand-offs are fixed, and every stage leaves its own note,
 * memory lines and trace.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();
	const maxRevisions = options.maxRevisions ?? options.config.maxRevisions;

	log('stage 1 of 3: research');
	const research = await runResearch({
		brief: options.brief,
		clientName: options.clientName,
		language: options.language,
		config: options.config,
		log,
		deps: options.deps,
		now,
	});
	if (research.report.confidence === 'low') {
		log('research confidence is low: the proposal will lean on questions for the client');
	}
	const clientName = options.clientName?.trim() || research.report.client_name;
	const researchNoteName = path.basename(research.reportPath, '.md');

	const attempts: PipelineAttempt[] = [];
	for (let version = 1; version <= maxRevisions + 1; version++) {
		const previous = attempts.at(-1);
		log(previous ? `revision ${version - 1} of ${maxRevisions}: proposal` : 'stage 2 of 3: proposal');
		const proposal = await runProposal({
			brief: options.brief,
			research: research.report,
			researchNoteName,
			clientName,
			language: options.language,
			version,
			revision: previous ? { proposal: previous.proposal.proposal, summary: previous.review.review.summary, findings: previous.review.findings } : undefined,
			config: options.config,
			log,
			deps: options.deps,
			now,
		});

		log(previous ? `revision ${version - 1} of ${maxRevisions}: review` : 'stage 3 of 3: review');
		const review = await runReview({
			brief: options.brief,
			research: research.report,
			proposal: proposal.proposal,
			proposalPath: proposal.proposalPath,
			proposalNoteName: path.basename(proposal.proposalPath, '.md'),
			researchNoteName,
			clientName,
			language: options.language,
			version,
			config: options.config,
			log,
			deps: options.deps,
			now,
		});
		attempts.push({ proposal, review });

		const counts = countFindings(review.findings);
		log(`verdict: ${review.verdict} (${counts.high} high, ${counts.medium} medium, ${counts.low} low)`);
		if (review.verdict === 'approve') {
			break;
		}
		if (version > maxRevisions) {
			log(maxRevisions === 0 ? 'no rewrites allowed: the proposal stays as reviewed' : 'no rewrites left: the proposal stays as reviewed');
		}
	}

	const last = attempts.at(-1);
	if (!last) {
		throw new Error('The pipeline produced no proposal.');
	}

	const usage = emptyUsage();
	const stages = [research.result.usage, ...attempts.flatMap((attempt) => [attempt.proposal.result.usage, attempt.review.result.usage])];
	for (const stage of stages) {
		usage.requests += stage.requests;
		usage.inputTokens += stage.inputTokens;
		usage.outputTokens += stage.outputTokens;
		usage.cacheReadTokens += stage.cacheReadTokens;
		usage.cacheWriteTokens += stage.cacheWriteTokens;
	}
	const costs = [research.cost, ...attempts.flatMap((attempt) => [attempt.proposal.cost, attempt.review.cost])];
	const cost = costs.some((value) => value === null) ? null : costs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
	const durationMs = now().getTime() - started.getTime();

	const runDir = runFolder(options.config.runsDir, started, ClientMemory.slug(clientName), 'pipeline');
	await mkdir(runDir, { recursive: true });
	await writeFile(
		path.join(runDir, 'summary.json'),
		JSON.stringify(
			{
				brief: options.brief,
				clientName,
				research: { runDir: research.runDir, reportPath: research.reportPath, confidence: research.report.confidence, fetches: research.fetches },
				proposal: { runDir: last.proposal.runDir, proposalPath: last.proposal.proposalPath, totals: last.proposal.totals, version: last.proposal.version },
				review: { runDir: last.review.runDir, reviewPath: last.review.reviewPath, verdict: last.review.verdict, findings: countFindings(last.review.findings) },
				attempts: attempts.map((attempt) => ({
					version: attempt.proposal.version,
					proposalRunDir: attempt.proposal.runDir,
					reviewRunDir: attempt.review.runDir,
					verdict: attempt.review.verdict,
					totals: attempt.proposal.totals,
				})),
				usage,
				cost,
				durationMs,
			},
			null,
			'\t',
		),
		'utf8',
	);

	return { research, proposal: last.proposal, review: last.review, attempts, usage, cost, durationMs, runDir };
}
