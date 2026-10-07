import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { CreateParams, LoopDeps, Message } from '../src/loop.ts';
import { runPipeline } from '../src/pipeline.ts';
import { runProposal } from '../src/propose.ts';
import { runReview } from '../src/review.ts';
import { sampleProposal } from './proposal.test.ts';
import { sampleReport } from './report.test.ts';
import { modelFinding, sampleReview } from './review.test.ts';

let dir: string;

const KNOWLEDGE = '# Services (AUD)\n\n| Servicio | Precio |\n|---|---|\n| Sitio web de hasta 5 páginas | $1.000 – $1.500 |\n| Chat con IA en el sitio web | $300 – $500 |\n';

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-pipeline-'));
	await mkdir(path.join(dir, 'knowledge'), { recursive: true });
	await writeFile(path.join(dir, 'knowledge', 'services.md'), KNOWLEDGE, 'utf8');
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

function testConfig(extra: NodeJS.ProcessEnv = {}) {
	return loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs'), ...extra }, dir);
}

describe('runProposal', () => {
	it('writes the proposal note, the client memory and the trace', async () => {
		const config = testConfig();
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'past_proposals', input: { limit: 5 } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_proposal', input: sampleProposal }]),
		]);
		const now = () => new Date(2026, 9, 1, 10, 0, 0);

		const outcome = await runProposal({ brief: 'Brief.', research: sampleReport, researchNoteName: "2026-10-01 Investigación Gina's Bakery", clientName: "Gina's Bakery", config, deps, now });

		expect(path.basename(outcome.proposalPath)).toBe("2026-10-01 Propuesta Gina's Bakery.md");
		expect(outcome.totals).toEqual({ min: 1300, max: 2000, mismatch: false });
		expect(outcome.version).toBe(1);
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
		// The research travels with the proposal run, so a review can start from this summary alone.
		expect(summary.research.client_name).toBe("Gina's Bakery");
		expect(summary.researchNoteName).toBe("2026-10-01 Investigación Gina's Bakery");
		expect(summary.revision).toBe(0);

		const firstResult = deps.requests[1]?.messages.at(-1)?.content;
		expect(JSON.stringify(firstResult)).toContain('No past proposals yet.');
		expect(deps.requests[0]?.system).toContain('proposal agent');
		expect(deps.requests[0]?.system).toContain('<agency_knowledge>');
		expect(deps.requests[0]?.messages[0]?.content).toContain('<research_report>');
		expect(deps.requests[0]?.messages[0]?.content).not.toContain('<previous_proposal>');
	});

	it('rewrites a proposal from a review, as version 2', async () => {
		const config = testConfig();
		const deps = fakeDeps([reply([{ type: 'tool_use', id: 'tu_1', name: 'submit_proposal', input: { ...sampleProposal, title: 'Versión corregida' } }])]);
		const now = () => new Date(2026, 9, 1, 10, 0, 0);

		const outcome = await runProposal({
			brief: 'Brief.',
			research: sampleReport,
			clientName: "Gina's Bakery",
			revision: { proposal: sampleProposal, summary: 'Hay que sacar Stripe.', findings: [modelFinding] },
			config,
			deps,
			now,
		});

		expect(outcome.version).toBe(2);
		expect(path.basename(outcome.runDir)).toBe('2026-10-01-100000-gina-s-bakery-proposal-v2');
		const message = String(deps.requests[0]?.messages[0]?.content);
		expect(message).toContain('<previous_proposal>\n{\n  "client_name": "Gina\'s Bakery"');
		expect(message).toContain('<review>\nHay que sacar Stripe.\n\n- [high] [technology] Ítem "Sitio web con pedidos": Nombra Stripe como pasarela de pago.');
		expect(message).toContain('This is a revision.');
		const memory = await readFile(outcome.memoryPath, 'utf8');
		expect(memory).toContain("- 2026-10-01 (proposal v2): Proposal: [[2026-10-01 Propuesta Gina's Bakery]]");
	});
});

describe('runReview', () => {
	it('runs the checks, asks the model, writes the review note, marks the proposal and records the verdict', async () => {
		const config = testConfig();
		await mkdir(config.proposalsDir, { recursive: true });
		const proposalPath = path.join(config.proposalsDir, "2026-10-01 Propuesta Gina's Bakery.md");
		await writeFile(proposalPath, '---\ntype: proposal\nstatus: draft\n---\n\n# Propuesta\n', 'utf8');
		const proposal = { ...sampleProposal, scope: [{ ...sampleProposal.scope[0]!, price_min: 800 }, ...sampleProposal.scope.slice(1)] };
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_review', input: { ...sampleReview, findings: [modelFinding] } }]),
		]);
		const now = () => new Date(2026, 9, 1, 12, 0, 0);
		const lines: string[] = [];

		const outcome = await runReview({
			brief: 'Brief.',
			research: sampleReport,
			proposal,
			proposalPath,
			proposalNoteName: "2026-10-01 Propuesta Gina's Bakery",
			researchNoteName: "2026-10-01 Investigación Gina's Bakery",
			clientName: "Gina's Bakery",
			config,
			deps,
			now,
			log: (line) => lines.push(line),
		});

		// The code found the price below the range; the model found Stripe; the model said approve but the code says revise.
		expect(outcome.checks.map((finding) => `${finding.severity} ${finding.category}`)).toEqual(['high price', 'medium price', 'low research']);
		expect(outcome.findings.map((finding) => `${finding.severity} ${finding.source}`)).toEqual(['high code', 'high model', 'medium code', 'low code']);
		expect(outcome.verdict).toBe('revise');
		expect(lines).toContain('checks: 3 finding(s) (1 high, 1 medium, 1 low)');
		expect(lines).toContain('verdict raised from "approve" to "revise" because of the findings');

		expect(path.basename(outcome.reviewPath)).toBe("2026-10-01 Revisión Gina's Bakery.md");
		const note = await readFile(outcome.reviewPath, 'utf8');
		expect(note).toContain('verdict: revise');
		expect(note).toContain("proposal: \"[[2026-10-01 Propuesta Gina's Bakery]]\"");
		expect(note).toContain('1. **[alta] Ítem "Sitio web con pedidos":** El mínimo (AUD 800) está por debajo del mínimo de la base');
		expect(note).toContain('*(chequeos)*');
		expect(note).toContain('Nombra Stripe como pasarela de pago.');

		const marked = await readFile(proposalPath, 'utf8');
		expect(marked.startsWith("---\ntype: proposal\nstatus: draft\nreview: \"[[2026-10-01 Revisión Gina's Bakery]]\"\nverdict: revise\n---\n")).toBe(true);
		expect(marked).toContain('# Propuesta');

		const memory = await readFile(outcome.memoryPath, 'utf8');
		expect(memory).toContain("- 2026-10-01 (review): Review: [[2026-10-01 Revisión Gina's Bakery]]");
		expect(memory).toContain('- 2026-10-01 (review): Verdict: revise (2 high, 1 medium, 1 low)');
		expect(memory).toContain('- 2026-10-01 (review): Finding (high): Ítem "Sitio web con pedidos": El mínimo (AUD 800)');
		expect(memory).toContain('- 2026-10-01 (review): Finding (high): Ítem "Sitio web con pedidos": Nombra Stripe');

		expect(path.basename(outcome.runDir)).toBe('2026-10-01-120000-gina-s-bakery-review');
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.verdict).toBe('revise');
		expect(summary.checks).toHaveLength(3);
		expect(summary.findings).toHaveLength(4);
		expect(summary.proposal.title).toBe(sampleProposal.title);

		// The reviewer reads memory and past proposals but cannot write memory: the harness does that.
		const toolNames = deps.requests[0]?.tools?.map((tool) => ('name' in tool ? tool.name : tool.type));
		expect(toolNames).toEqual(['recall_client', 'past_proposals', 'submit_review']);
		expect(deps.requests[0]?.system).toContain('quality reviewer');
		const message = String(deps.requests[0]?.messages[0]?.content);
		expect(message).toContain('<proposal>');
		expect(message).toContain('<automated_checks>\n- [high] [price] Ítem "Sitio web con pedidos": El mínimo (AUD 800)');
	});
});

describe('runPipeline', () => {
	it('runs research, proposal and review, and links the three', async () => {
		const config = testConfig();
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_research', input: sampleReport }]),
			reply([{ type: 'tool_use', id: 'tu_3', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_4', name: 'submit_proposal', input: sampleProposal }]),
			reply([{ type: 'tool_use', id: 'tu_5', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_6', name: 'submit_review', input: sampleReview }]),
		]);
		const now = () => new Date(2026, 9, 1, 11, 30, 0);
		const lines: string[] = [];

		const outcome = await runPipeline({ brief: "Gina's Bakery, panadería en Bondi. Sin web.", clientName: "Gina's Bakery", language: 'es', config, deps, now, log: (line) => lines.push(line) });

		expect(path.basename(outcome.research.reportPath)).toBe("2026-10-01 Investigación Gina's Bakery.md");
		expect(path.basename(outcome.proposal.proposalPath)).toBe("2026-10-01 Propuesta Gina's Bakery.md");
		expect(path.basename(outcome.review.reviewPath)).toBe("2026-10-01 Revisión Gina's Bakery.md");
		expect(outcome.review.verdict).toBe('approve');
		expect(outcome.attempts).toHaveLength(1);
		expect(outcome.usage).toEqual({ requests: 6, inputTokens: 600, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(outcome.cost).toBeNull();
		expect(lines).toContain('stage 1 of 3: research');
		expect(lines).toContain('stage 2 of 3: proposal');
		expect(lines).toContain('stage 3 of 3: review');
		expect(lines).toContain('verdict: approve (0 high, 0 medium, 1 low)');

		const proposal = await readFile(outcome.proposal.proposalPath, 'utf8');
		expect(proposal).toContain("research: \"[[2026-10-01 Investigación Gina's Bakery]]\"");
		expect(proposal).toContain("review: \"[[2026-10-01 Revisión Gina's Bakery]]\"");
		expect(proposal).toContain('verdict: approve');

		const review = await readFile(outcome.review.reviewPath, 'utf8');
		expect(review).toContain("proposal: \"[[2026-10-01 Propuesta Gina's Bakery]]\"");
		expect(review).toContain("research: \"[[2026-10-01 Investigación Gina's Bakery]]\"");

		const memory = await readFile(outcome.proposal.memoryPath, 'utf8');
		expect(memory).toContain("(research): Research report: [[2026-10-01 Investigación Gina's Bakery]]");
		expect(memory).toContain("(proposal): Proposal: [[2026-10-01 Propuesta Gina's Bakery]]");
		expect(memory).toContain("(review): Review: [[2026-10-01 Revisión Gina's Bakery]]");
		expect(memory).toContain('(review): Verdict: approve (0 high, 0 medium, 1 low)');

		// Each agent saw the memory the one before it had just written.
		expect(JSON.stringify(deps.requests[3]?.messages.at(-1)?.content)).toContain('Research report: [[2026-10-01');
		expect(JSON.stringify(deps.requests[5]?.messages.at(-1)?.content)).toContain('Quoted AUD 1.300 – AUD 2.000');

		const runs = (await readdir(path.join(dir, 'runs'))).sort();
		expect(runs).toEqual(['2026-10-01-113000-gina-s-bakery', '2026-10-01-113000-gina-s-bakery-pipeline', '2026-10-01-113000-gina-s-bakery-proposal', '2026-10-01-113000-gina-s-bakery-review']);
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.proposal.totals).toEqual({ min: 1300, max: 2000, mismatch: false });
		expect(summary.research.confidence).toBe('medium');
		expect(summary.review.verdict).toBe('approve');
		expect(summary.review.findings).toEqual({ high: 0, medium: 0, low: 1 });
		expect(summary.attempts).toHaveLength(1);
	});

	it('sends the review back to the proposal agent and reviews the rewrite', async () => {
		const config = testConfig();
		const revised = { ...sampleProposal, title: 'Versión corregida' };
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'submit_research', input: sampleReport }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_proposal', input: sampleProposal }]),
			reply([{ type: 'tool_use', id: 'tu_3', name: 'submit_review', input: { ...sampleReview, verdict: 'revise', findings: [modelFinding] } }]),
			reply([{ type: 'tool_use', id: 'tu_4', name: 'submit_proposal', input: revised }]),
			reply([{ type: 'tool_use', id: 'tu_5', name: 'submit_review', input: sampleReview }]),
		]);
		const now = () => new Date(2026, 9, 1, 11, 30, 0);
		const lines: string[] = [];

		const outcome = await runPipeline({ brief: 'Brief.', clientName: "Gina's Bakery", config, deps, now, log: (line) => lines.push(line) });

		expect(outcome.attempts.map((attempt) => `${attempt.proposal.version}: ${attempt.review.verdict}`)).toEqual(['1: revise', '2: approve']);
		expect(outcome.proposal.proposal.title).toBe('Versión corregida');
		expect(outcome.review.verdict).toBe('approve');
		expect(outcome.usage.requests).toBe(5);
		expect(lines).toContain('revision 1 of 1: proposal');
		expect(lines).toContain('revision 1 of 1: review');

		// The rewrite got the first proposal and the review's findings.
		const rewriteMessage = String(deps.requests[3]?.messages[0]?.content);
		expect(rewriteMessage).toContain('<previous_proposal>');
		expect(rewriteMessage).toContain('Nombra Stripe como pasarela de pago.');
		expect(rewriteMessage).toContain('This is a revision.');

		// The notes show the last version; the runs keep every attempt.
		const proposal = await readFile(outcome.proposal.proposalPath, 'utf8');
		expect(proposal).toContain('# Versión corregida');
		expect(proposal).toContain('verdict: approve');
		const memory = await readFile(outcome.proposal.memoryPath, 'utf8');
		expect(memory).toContain('(review): Verdict: revise (1 high, 0 medium, 1 low)');
		expect(memory).toContain('(proposal v2): Proposal:');
		expect(memory).toContain('(review v2): Verdict: approve (0 high, 0 medium, 1 low)');
		const runs = (await readdir(path.join(dir, 'runs'))).sort();
		expect(runs).toContain('2026-10-01-113000-gina-s-bakery-proposal-v2');
		expect(runs).toContain('2026-10-01-113000-gina-s-bakery-review-v2');
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.attempts.map((attempt: { version: number; verdict: string }) => `${attempt.version}: ${attempt.verdict}`)).toEqual(['1: revise', '2: approve']);
		expect(summary.proposal.version).toBe(2);
	});

	it('stops after one review when no rewrites are allowed', async () => {
		const config = testConfig({ BRAIN_MAX_REVISIONS: '0' });
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'submit_research', input: sampleReport }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_proposal', input: sampleProposal }]),
			reply([{ type: 'tool_use', id: 'tu_3', name: 'submit_review', input: { ...sampleReview, verdict: 'revise', findings: [modelFinding] } }]),
		]);
		const lines: string[] = [];

		const outcome = await runPipeline({ brief: 'Brief.', clientName: "Gina's Bakery", config, deps, now: () => new Date(2026, 9, 1, 11, 30, 0), log: (line) => lines.push(line) });

		expect(outcome.attempts).toHaveLength(1);
		expect(outcome.review.verdict).toBe('revise');
		expect(lines).toContain('no rewrites allowed: the proposal stays as reviewed');
	});
});
