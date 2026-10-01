import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildResearchMessage, createResearchAgent, type ReportLanguage, type ResearchReport } from './agents/research.ts';
import { describeProvider, type BrainConfig } from './config.ts';
import { AgentRunError, runAgent, type LoopDeps, type RunResult } from './loop.ts';
import { estimateCost } from './pricing.ts';
import { createLoopDeps } from './provider.ts';
import { renderResearchReport, reportFileName } from './report.ts';
import { createFetchUrlTool } from './tools/fetchUrl.ts';
import { loadKnowledge, renderKnowledge } from './tools/knowledge.ts';
import { ClientMemory, createMemoryTools, isoDate } from './tools/memory.ts';
import { runFolder, writeTrace } from './trace.ts';

export interface ResearchRunOptions {
	brief: string;
	clientName?: string;
	language?: ReportLanguage;
	config: BrainConfig;
	log?: (line: string) => void;
	/** Replaces the real API client, for tests. */
	deps?: LoopDeps;
	now?: () => Date;
}

export interface ResearchRunOutcome {
	report: ResearchReport;
	reportPath: string;
	memoryPath: string;
	runDir: string;
	result: RunResult<ResearchReport>;
	cost: number | null;
	fetches: number;
}

/** One research run, end to end: knowledge + tools + agent, then the report note, the client memory and the trace. */
export async function runResearch(options: ResearchRunOptions): Promise<ResearchRunOutcome> {
	const { config } = options;
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const started = now();
	const today = isoDate(started);

	const notes = await loadKnowledge(config.knowledgeDir);
	if (notes.length === 0) {
		log(`warning: no knowledge notes in ${config.knowledgeDir}, so opportunities will not be matched to services or prices`);
	}
	const memory = new ClientMemory(config.clientsDir);
	const budget = { used: 0 };
	const tools = [createFetchUrlTool({ maxChars: config.maxToolResultChars, maxFetches: config.maxFetches }, budget), ...createMemoryTools(memory, now)];
	const agent = createResearchAgent({ knowledge: renderKnowledge(notes), tools, maxFetches: config.maxFetches });
	const deps = options.deps ?? createLoopDeps(config);
	const message = buildResearchMessage({ brief: options.brief, clientName: options.clientName, language: options.language, today });
	const runDir = runFolder(config.runsDir, started, ClientMemory.slug(options.clientName ?? options.brief.slice(0, 40)));

	let result: RunResult<ResearchReport>;
	try {
		result = await runAgent(deps, agent, message, { maxSteps: config.maxSteps, log, now });
	} catch (error) {
		if (error instanceof AgentRunError) {
			await writeTrace(runDir, { steps: error.steps, messages: error.messages, usage: error.usage, brief: options.brief, failure: error.reason, error: error.message });
		}
		throw error;
	}

	const report = result.output;
	const cost = estimateCost(result.model, result.usage);
	const clientName = options.clientName?.trim() || report.client_name.trim() || 'client';
	const fileName = reportFileName(today, clientName, report.language);
	const reportPath = path.join(config.reportsDir, fileName);
	const markdown = renderResearchReport(report, {
		date: today,
		model: result.model,
		provider: describeProvider(config),
		usage: result.usage,
		cost,
		durationMs: result.durationMs,
		steps: result.steps.length,
		fetches: budget.used,
		brief: options.brief,
	});
	await mkdir(config.reportsDir, { recursive: true });
	await writeFile(reportPath, markdown, 'utf8');

	const memoryPath = await memory.append(clientName, memoryFacts(report, fileName.slice(0, -3)), 'research', started);
	await writeTrace(runDir, { steps: result.steps, messages: result.messages, usage: result.usage, model: result.model, cost, brief: options.brief, reportPath, report });

	return { report, reportPath, memoryPath, runDir, result, cost, fetches: budget.used };
}

/** What the next agent or person should know, written by the harness so it does not depend on the model remembering to. */
export function memoryFacts(report: ResearchReport, reportNoteName: string): string[] {
	const facts: string[] = [];
	if (report.website) {
		facts.push(`Website: ${report.website}`);
	}
	facts.push(`${report.business.industry}; ${report.business.location}; segment: ${report.business.segment}`);
	facts.push(report.summary);
	for (const problem of report.problems.slice(0, 2)) {
		facts.push(`Problem (${problem.impact}): ${problem.problem}`);
	}
	facts.push(`Research report: [[${reportNoteName}]]`);
	return facts;
}
