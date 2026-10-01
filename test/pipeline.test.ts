import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { CreateParams, LoopDeps, Message } from '../src/loop.ts';
import { runPipeline } from '../src/pipeline.ts';
import { runProposal } from '../src/propose.ts';
import { sampleProposal } from './proposal.test.ts';
import { sampleReport } from './report.test.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-pipeline-'));
	await mkdir(path.join(dir, 'knowledge'), { recursive: true });
	await writeFile(path.join(dir, 'knowledge', 'services.md'), '# Services\n\n| Sitio web de hasta 5 páginas | $1.000 – $1.500 |\n', 'utf8');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function reply(content: unknown[], stop = 'tool_use'): Message {
	return {
		id: 'msg',
		type: 'message',
		role: 'assistant',
		model: 'fake-model',
		content,
		stop_reason: stop,
		stop_sequence: null,
		stop_details: null,
		usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	} as unknown as Message;
}

function fakeDeps(replies: Message[]): LoopDeps & { requests: CreateParams[] } {
	const requests: CreateParams[] = [];
	return {
		requests,
		async createMessage(params) {
			requests.push(structuredClone(params));
			const next = replies.shift();
			if (!next) {
				throw new Error('No more fake replies');
			}
			return next;
		},
		buildRequest(parts) {
			return { model: 'fake-model', max_tokens: parts.maxTokens, system: parts.system, tools: parts.tools, messages: parts.messages };
		},
	};
}

describe('runProposal', () => {
	it('writes the proposal note, the client memory and the trace', async () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs') }, dir);
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'past_proposals', input: { limit: 5 } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_proposal', input: sampleProposal }]),
		]);
		const now = () => new Date(2026, 9, 1, 10, 0, 0);

		const outcome = await runProposal({ brief: 'Brief.', research: sampleReport, researchNoteName: "2026-10-01 Investigación Gina's Bakery", clientName: "Gina's Bakery", config, deps, now });

		expect(path.basename(outcome.proposalPath)).toBe("2026-10-01 Propuesta Gina's Bakery.md");
		expect(outcome.totals).toEqual({ min: 1300, max: 2000, mismatch: false });
		const note = await readFile(outcome.proposalPath, 'utf8');
		expect(note).toContain("# Gina's Bakery: pedidos online sin depender de Instagram");
		expect(note).toContain("- Investigación: [[2026-10-01 Investigación Gina's Bakery]]");

		const memory = await readFile(outcome.memoryPath, 'utf8');
		expect(memory).toContain("- 2026-10-01 (proposal): Proposal: [[2026-10-01 Propuesta Gina's Bakery]]");
		expect(memory).toContain('- 2026-10-01 (proposal): Quoted AUD 1.300 – AUD 2.000 for: Sitio web de hasta 5 páginas, Chat con IA en el sitio web');
		expect(memory).toContain('- 2026-10-01 (proposal): Open question: ¿Cuántos pedidos reciben por semana?');

		expect(path.basename(outcome.runDir)).toBe('2026-10-01-100000-gina-s-bakery-proposal');
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.report.title).toBe(sampleProposal.title);
		expect(summary.brief).toBe('Brief.');

		const firstResult = deps.requests[1]?.messages.at(-1)?.content;
		expect(JSON.stringify(firstResult)).toContain('No past proposals yet.');
		expect(deps.requests[0]?.system).toContain('proposal agent');
		expect(deps.requests[0]?.system).toContain('<agency_knowledge>');
		expect(deps.requests[0]?.messages[0]?.content).toContain('<research_report>');
	});
});

describe('runPipeline', () => {
	it('runs research, then the proposal from it, and links the two', async () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs') }, dir);
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_research', input: sampleReport }]),
			reply([{ type: 'tool_use', id: 'tu_3', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_4', name: 'submit_proposal', input: sampleProposal }]),
		]);
		const now = () => new Date(2026, 9, 1, 11, 30, 0);
		const lines: string[] = [];

		const outcome = await runPipeline({ brief: "Gina's Bakery, panadería en Bondi. Sin web.", clientName: "Gina's Bakery", language: 'es', config, deps, now, log: (line) => lines.push(line) });

		expect(path.basename(outcome.research.reportPath)).toBe("2026-10-01 Investigación Gina's Bakery.md");
		expect(path.basename(outcome.proposal.proposalPath)).toBe("2026-10-01 Propuesta Gina's Bakery.md");
		expect(outcome.usage).toEqual({ requests: 4, inputTokens: 400, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(outcome.cost).toBeNull();
		expect(lines).toContain('stage 1 of 2: research');
		expect(lines).toContain('stage 2 of 2: proposal');

		const proposal = await readFile(outcome.proposal.proposalPath, 'utf8');
		expect(proposal).toContain("research: \"[[2026-10-01 Investigación Gina's Bakery]]\"");

		const memory = await readFile(outcome.proposal.memoryPath, 'utf8');
		expect(memory).toContain("(research): Research report: [[2026-10-01 Investigación Gina's Bakery]]");
		expect(memory).toContain("(proposal): Proposal: [[2026-10-01 Propuesta Gina's Bakery]]");

		// The proposal agent saw the client memory that research had just written.
		const recallResult = JSON.stringify(deps.requests[3]?.messages.at(-1)?.content);
		expect(recallResult).toContain('Research report: [[2026-10-01');

		const runs = (await readdir(path.join(dir, 'runs'))).sort();
		expect(runs).toEqual(['2026-10-01-113000-gina-s-bakery', '2026-10-01-113000-gina-s-bakery-pipeline', '2026-10-01-113000-gina-s-bakery-proposal']);
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.proposal.totals).toEqual({ min: 1300, max: 2000, mismatch: false });
		expect(summary.research.confidence).toBe('medium');
	});
});
