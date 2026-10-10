import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCost, formatDuration, listRuns, renderRunsTable, summarizeRuns, type RunRecord } from '../src/metrics.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-metrics-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function run(name: string, files: Record<string, unknown>): Promise<void> {
	await mkdir(path.join(dir, name), { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		await writeFile(path.join(dir, name, file), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
	}
}

const usage = { requests: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 };

describe('listRuns', () => {
	it('reads new and old run folders, newest first, and infers what old summaries lack', async () => {
		// A run from v0.5: everything in the summary.
		await run('2026-10-10-120000-gina-s-bakery-pipeline', {
			'summary.json': { kind: 'pipeline', client: "Gina's Bakery", startedAt: '2026-10-10T12:00:00.000Z', model: 'claude-opus-5-5', steps: 9, usage, cost: 0.31, durationMs: 140_000, verdict: 'approve' },
		});
		// A run from before v0.5: no kind, client, start or duration; the folder name and the trace fill them in.
		await run('2026-09-30-180539-bourke-street-bakery', {
			'summary.json': { usage, model: 'qwen3.6:35b-a3b', cost: null, steps: 6 },
			'trace.jsonl': [JSON.stringify({ step: 1, durationMs: 60_000, toolCalls: [{ durationMs: 1_500 }] }), JSON.stringify({ step: 2, durationMs: 30_000, toolCalls: [] })].join('\n') + '\n',
		});
		await run('2026-10-01-204019-bourke-street-bakery-proposal-v2', { 'summary.json': { usage, model: 'qwen3.6:35b-a3b', cost: null, steps: 3, revision: 1 } });
		// A failed run keeps its failure.
		await run('2026-10-02-090000-acme-review', { 'summary.json': { kind: 'review', client: 'Acme', startedAt: '2026-10-02T09:00:00.000Z', usage, model: 'claude-opus-5-5', durationMs: 5_000, failure: 'refusal', error: 'The model declined.' } });
		// Evals keep results.json.
		await run('2026-10-07-174705-evals', {
			'results.json': { model: 'qwen3.6:35b-a3b', durationMs: 2_300_000, usage, cost: null, review: [{ score: { pass: true } }, { score: { pass: false } }], research: [{ score: { pass: true } }] },
		});
		// Noise: a folder without a summary and a stray file.
		await mkdir(path.join(dir, 'empty'));
		await writeFile(path.join(dir, 'notes.txt'), 'x', 'utf8');

		const records = await listRuns(dir);
		expect(records.map((record) => record.name)).toEqual([
			'2026-10-10-120000-gina-s-bakery-pipeline',
			'2026-10-07-174705-evals',
			'2026-10-02-090000-acme-review',
			'2026-10-01-204019-bourke-street-bakery-proposal-v2',
			'2026-09-30-180539-bourke-street-bakery',
		]);

		const [pipeline, evals, review, proposal, research] = records as [RunRecord, RunRecord, RunRecord, RunRecord, RunRecord];
		expect(pipeline).toMatchObject({ kind: 'pipeline', client: "Gina's Bakery", model: 'claude-opus-5-5', steps: 9, cost: 0.31, durationMs: 140_000, outcome: 'approve', failed: false });
		expect(evals).toMatchObject({ kind: 'evals', client: null, durationMs: 2_300_000, outcome: '2/3 cases', steps: null });
		expect(review).toMatchObject({ kind: 'review', client: 'Acme', outcome: 'failed: refusal', failed: true });
		expect(proposal).toMatchObject({ kind: 'proposal', client: 'bourke-street-bakery', durationMs: null, outcome: null });
		expect(research).toMatchObject({ kind: 'research', client: 'bourke-street-bakery', steps: 6, durationMs: 91_500, cost: null });
		expect(research.startedAt).toBe(new Date(2026, 8, 30, 18, 5, 39).toISOString());
	});

	it('returns nothing for a missing folder', async () => {
		expect(await listRuns(path.join(dir, 'nope'))).toEqual([]);
	});
});

describe('summarizeRuns and renderRunsTable', () => {
	const record = (overrides: Partial<RunRecord>): RunRecord => ({
		name: 'run',
		dir: '/runs/run',
		kind: 'pipeline',
		startedAt: new Date(2026, 9, 10, 12, 0, 0).toISOString(),
		client: 'Gina',
		model: 'claude-opus-5-5',
		steps: 9,
		usage,
		cost: 0.3,
		durationMs: 120_000,
		outcome: 'approve',
		failed: false,
		...overrides,
	});

	it('averages time and cost per kind, counting unpriced runs apart', () => {
		const records = [
			record({ name: 'p1' }),
			record({ name: 'p2', cost: 0.5, durationMs: 180_000, outcome: 'revise' }),
			record({ name: 'r1', kind: 'research', cost: null, model: 'qwen3.6:35b-a3b', durationMs: null, outcome: null }),
			record({ name: 'r2', kind: 'research', cost: 0.1, durationMs: 60_000, failed: true, outcome: 'failed: refusal' }),
		];
		const summary = summarizeRuns(records);
		expect(summary.runs).toBe(4);
		expect(summary.failed).toBe(1);
		expect(summary.totalCost).toBeCloseTo(0.9);
		expect(summary.unpriced).toBe(1);
		expect(summary.usage.requests).toBe(12);
		expect(summary.kinds.map((kind) => kind.kind)).toEqual(['pipeline', 'research']);
		expect(summary.kinds[0]).toMatchObject({ runs: 2, failed: 0, averageDurationMs: 150_000, totalCost: 0.8 });
		expect(summary.kinds[0]?.averageCost).toBeCloseTo(0.4);
		expect(summary.kinds[1]).toMatchObject({ runs: 2, failed: 1, averageDurationMs: 60_000, averageCost: 0.1, totalCost: 0.1 });

		const lines = renderRunsTable(records, summary, { limit: 3 });
		expect(lines[0]).toBe('Started           Kind      Client  Model            Steps  Time     Cost    Outcome');
		expect(lines[2]).toBe('2026-10-10 12:00  pipeline  Gina    claude-opus-5-5  9      3.0 min  ~$0.50  revise');
		expect(lines[3]).toBe('2026-10-10 12:00  research  Gina    qwen3.6:35b-a3b  9      -        n/a     -');
		expect(lines[4]).toBe('... and 1 more');
		expect(lines).toContain('pipeline  2 runs, avg 2.5 min, avg ~$0.40, 3,000 tokens in, 400 out');
		expect(lines).toContain('research  2 runs, 1 failed, avg 1.0 min, avg ~$0.10, 3,000 tokens in, 400 out');
		expect(lines.at(-1)).toBe('total     4 runs, 12 requests, cost ~$0.90 (1 run on a model with no price, not counted)');
	});

	it('formats durations and costs for people', () => {
		expect(formatDuration(12_400)).toBe('12 s');
		expect(formatDuration(338_000)).toBe('5.6 min');
		expect(formatDuration(5_400_000)).toBe('1.5 h');
		expect(formatCost(null)).toBe('n/a');
		expect(formatCost(0)).toBe('~$0.00');
		expect(formatCost(0.0042)).toBe('~$0.0042');
		expect(formatCost(0.31)).toBe('~$0.31');
	});
});
