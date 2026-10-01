import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReportLanguage } from './agents/research.ts';
import type { BrainConfig } from './config.ts';
import type { LoopDeps } from './loop.ts';
import { emptyUsage, type UsageTotals } from './pricing.ts';
import { runProposal, type ProposalRunOutcome } from './propose.ts';
import { runResearch, type ResearchRunOutcome } from './run.ts';
import { ClientMemory } from './tools/memory.ts';
import { runFolder } from './trace.ts';

export interface PipelineOptions {
	brief: string;
	clientName?: string;
	language?: ReportLanguage;
	config: BrainConfig;
	log?: (line: string) => void;
	deps?: LoopDeps;
	now?: () => Date;
}

export interface PipelineOutcome {
	research: ResearchRunOutcome;
	proposal: ProposalRunOutcome;
	usage: UsageTotals;
	cost: number | null;
	durationMs: number;
	runDir: string;
}

/**
 * The orchestrator: research first, then the proposal written from that research. Plain code, no model
 * in between: each stage is an agent, the order and the hand-off are fixed, and every stage leaves its
 * own note, memory lines and trace.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();

	log('stage 1 of 2: research');
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

	log('stage 2 of 2: proposal');
	const clientName = options.clientName?.trim() || research.report.client_name;
	const proposal = await runProposal({
		brief: options.brief,
		research: research.report,
		researchNoteName: path.basename(research.reportPath, '.md'),
		clientName,
		language: options.language,
		config: options.config,
		log,
		deps: options.deps,
		now,
	});

	const usage = emptyUsage();
	for (const stage of [research.result.usage, proposal.result.usage]) {
		usage.requests += stage.requests;
		usage.inputTokens += stage.inputTokens;
		usage.outputTokens += stage.outputTokens;
		usage.cacheReadTokens += stage.cacheReadTokens;
		usage.cacheWriteTokens += stage.cacheWriteTokens;
	}
	const cost = research.cost === null || proposal.cost === null ? null : research.cost + proposal.cost;
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
				proposal: { runDir: proposal.runDir, proposalPath: proposal.proposalPath, totals: proposal.totals },
				usage,
				cost,
				durationMs,
			},
			null,
			'\t',
		),
		'utf8',
	);

	return { research, proposal, usage, cost, durationMs, runDir };
}
