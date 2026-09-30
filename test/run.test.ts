import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { CreateParams, LoopDeps, Message } from '../src/loop.ts';
import { runResearch } from '../src/run.ts';
import { sampleReport } from './report.test.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-run-'));
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

describe('runResearch', () => {
	it('writes the report note, the client memory and the trace', async () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs') }, dir);
		const deps = fakeDeps([
			reply([{ type: 'tool_use', id: 'tu_1', name: 'recall_client', input: { name: "Gina's Bakery" } }]),
			reply([{ type: 'tool_use', id: 'tu_2', name: 'remember_client', input: { name: "Gina's Bakery", facts: ['Vende por Instagram'] } }]),
			reply([{ type: 'tool_use', id: 'tu_3', name: 'submit_research', input: sampleReport }]),
		]);
		const now = () => new Date(2026, 8, 30, 15, 4, 5);
		const lines: string[] = [];

		const outcome = await runResearch({ brief: "Gina's Bakery, panadería en Bondi. Sin web.", clientName: "Gina's Bakery", config, deps, now, log: (line) => lines.push(line) });

		expect(outcome.report.client_name).toBe("Gina's Bakery");
		expect(outcome.fetches).toBe(0);
		expect(outcome.cost).toBeNull();
		expect(outcome.result.steps).toHaveLength(3);
		expect(path.basename(outcome.reportPath)).toBe("2026-09-30 Investigación Gina's Bakery.md");

		const report = await readFile(outcome.reportPath, 'utf8');
		expect(report).toContain("# Gina's Bakery: investigación");
		expect(report).toContain('- Modelo: fake-model (claude-opus-5-5 on the Claude API)');

		const memory = await readFile(outcome.memoryPath, 'utf8');
		expect(path.basename(outcome.memoryPath)).toBe('gina-s-bakery.md');
		expect(memory).toContain('- 2026-09-30 (agent): Vende por Instagram');
		expect(memory).toContain('- 2026-09-30 (research): Website: https://ginas.example.com');
		expect(memory).toContain('- 2026-09-30 (research): Problem (high): Sin sitio web');
		expect(memory).toContain("- 2026-09-30 (research): Research report: [[2026-09-30 Investigación Gina's Bakery]]");

		expect(path.basename(outcome.runDir)).toBe('2026-09-30-150405-gina-s-bakery');
		expect((await readdir(outcome.runDir)).sort()).toEqual(['messages.json', 'summary.json', 'trace.jsonl']);
		const summary = JSON.parse(await readFile(path.join(outcome.runDir, 'summary.json'), 'utf8'));
		expect(summary.steps).toBe(3);
		expect(summary.report.client_name).toBe("Gina's Bakery");

		expect(deps.requests[0]?.system).toContain('<agency_knowledge>');
		expect(deps.requests[0]?.system).toContain('Sitio web de hasta 5 páginas');
		expect(deps.requests[0]?.messages[0]?.content).toContain('<brief>');
		expect(deps.requests[0]?.messages[0]?.content).toContain('Language of the report: the language of the brief');
		expect(lines.some((line) => line.includes('recall_client'))).toBe(true);
	});

	it('saves the trace when the run fails', async () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs'), BRAIN_MAX_STEPS: '1' }, dir);
		const deps = fakeDeps([reply([{ type: 'tool_use', id: 'tu_1', name: 'recall_client', input: { name: 'X' } }])]);
		await expect(runResearch({ brief: 'X, a shop.', clientName: 'X', language: 'es', config, deps, now: () => new Date(2026, 8, 30) })).rejects.toMatchObject({ reason: 'step_limit' });
		expect(deps.requests[0]?.messages[0]?.content).toContain('Language of the report: Spanish (es)');
		const runs = await readdir(path.join(dir, 'runs'));
		expect(runs).toHaveLength(1);
		const summary = JSON.parse(await readFile(path.join(dir, 'runs', runs[0]!, 'summary.json'), 'utf8'));
		expect(summary.failure).toBe('step_limit');
	});
});
