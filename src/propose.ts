import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProposalMessage, createProposalAgent, type Proposal } from './agents/proposal.ts';
import type { ReportLanguage, ResearchReport } from './agents/research.ts';
import { describeProvider, type BrainConfig } from './config.ts';
import { AgentRunError, runAgent, type LoopDeps, type RunResult } from './loop.ts';
import { estimateCost } from './pricing.ts';
import { formatMoney, proposalFileName, proposalTotals, renderProposal, type ProposalTotals } from './proposalReport.ts';
import { createLoopDeps } from './provider.ts';
import { loadKnowledge, renderKnowledge } from './tools/knowledge.ts';
import { ClientMemory, createMemoryTools, isoDate } from './tools/memory.ts';
import { createPastProposalsTool, ProposalStore } from './tools/proposals.ts';
import { runFolder, writeTrace } from './trace.ts';

export interface ProposalRunOptions {
	brief: string;
	research: ResearchReport;
	/** Note name of the research report, without the extension, to link it from the proposal. */
	researchNoteName?: string;
	clientName?: string;
	language?: ReportLanguage;
	config: BrainConfig;
	log?: (line: string) => void;
	/** Replaces the real API client, for tests. */
	deps?: LoopDeps;
	now?: () => Date;
}

export interface ProposalRunOutcome {
	proposal: Proposal;
	proposalPath: string;
	memoryPath: string;
	runDir: string;
	result: RunResult<Proposal>;
	cost: number | null;
	totals: ProposalTotals;
}

/** One proposal run: knowledge + memory + past proposals + agent, then the proposal note, the client memory and the trace. */
export async function runProposal(options: ProposalRunOptions): Promise<ProposalRunOutcome> {
	const { config } = options;
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();
	const today = isoDate(started);

	const notes = await loadKnowledge(config.knowledgeDir);
	if (notes.length === 0) {
		log(`warning: no knowledge notes in ${config.knowledgeDir}, so the proposal will have no services or prices to quote`);
	}
	const memory = new ClientMemory(config.clientsDir);
	const store = new ProposalStore(config.proposalsDir);
	const tools = [...createMemoryTools(memory, now), createPastProposalsTool(store)];
	const agent = createProposalAgent({ knowledge: renderKnowledge(notes), tools });
	const deps = options.deps ?? createLoopDeps(config);
	const clientName = options.clientName?.trim() || options.research.client_name.trim() || 'client';
	const message = buildProposalMessage({ brief: options.brief, research: options.research, clientName, language: options.language, today });
	const runDir = runFolder(config.runsDir, started, ClientMemory.slug(clientName), 'proposal');

	let result: RunResult<Proposal>;
	try {
		result = await runAgent(deps, agent, message, { maxSteps: config.maxSteps, log, now });
	} catch (error) {
		if (error instanceof AgentRunError) {
			await writeTrace(runDir, { steps: error.steps, messages: error.messages, usage: error.usage, brief: options.brief, failure: error.reason, error: error.message });
		}
		throw error;
	}

	const proposal = result.output;
	const cost = estimateCost(result.model, result.usage);
	const totals = proposalTotals(proposal);
	const fileName = proposalFileName(today, clientName, proposal.language);
	const proposalPath = path.join(config.proposalsDir, fileName);
	const markdown = renderProposal(proposal, {
		date: today,
		model: result.model,
		provider: describeProvider(config),
		usage: result.usage,
		cost,
		durationMs: result.durationMs,
		steps: result.steps.length,
		researchNoteName: options.researchNoteName,
		brief: options.brief,
	});
	await mkdir(config.proposalsDir, { recursive: true });
	await writeFile(proposalPath, markdown, 'utf8');

	const memoryPath = await memory.append(clientName, proposalFacts(proposal, fileName.slice(0, -3), totals), 'proposal', started);
	await writeTrace(runDir, { steps: result.steps, messages: result.messages, usage: result.usage, model: result.model, cost, brief: options.brief, reportPath: proposalPath, report: proposal });

	return { proposal, proposalPath, memoryPath, runDir, result, cost, totals };
}

/** What the client's note keeps about this proposal, written by the harness. */
export function proposalFacts(proposal: Proposal, noteName: string, totals: ProposalTotals): string[] {
	const currency = proposal.investment.currency || 'AUD';
	const core = proposal.scope.filter((item) => item.priority === 'core').map((item) => item.service);
	const facts = [
		`Proposal: [[${noteName}]]`,
		`Quoted ${formatMoney(totals.min, currency, proposal.language)} – ${formatMoney(totals.max, currency, proposal.language)} for: ${core.join(', ') || 'no priced items'}`,
	];
	for (const question of proposal.internal.questions_for_client.slice(0, 2)) {
		facts.push(`Open question: ${question}`);
	}
	return facts;
}
