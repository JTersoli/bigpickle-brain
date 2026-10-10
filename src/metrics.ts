import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { emptyUsage, type UsageTotals } from './pricing.ts';
import type { RunKind } from './trace.ts';

/** What the metrics keep about one run folder, read from its summary.json (or results.json for evals). */
export interface RunRecord {
	/** The folder name, `2026-10-01-113000-gina-s-bakery-pipeline`. */
	name: string;
	dir: string;
	kind: RunKind;
	/** ISO date and time the run started, from the summary or the folder name. */
	startedAt: string;
	client: string | null;
	model: string | null;
	steps: number | null;
	usage: UsageTotals | null;
	cost: number | null;
	durationMs: number | null;
	/** Review and pipeline runs: the verdict. Evals: `passed/total cases`. Failed runs: the failure. */
	outcome: string | null;
	failed: boolean;
}

export interface KindSummary {
	kind: RunKind;
	runs: number;
	failed: number;
	/** Over the runs that recorded a duration. */
	averageDurationMs: number | null;
	/** Over the runs with a known cost. */
	averageCost: number | null;
	totalCost: number;
	usage: UsageTotals;
}

export interface RunsSummary {
	runs: number;
	failed: number;
	totalCost: number;
	/** Runs whose model has no price: their cost is unknown, not zero. */
	unpriced: number;
	usage: UsageTotals;
	kinds: KindSummary[];
}

const KINDS: readonly RunKind[] = ['pipeline', 'research', 'proposal', 'review', 'evals'];

/** Reads every run folder in `runsDir`, newest first. Folders without a summary are skipped. */
export async function listRuns(runsDir: string): Promise<RunRecord[]> {
	let names: string[];
	try {
		names = await readdir(runsDir);
	} catch {
		return [];
	}
	const records: RunRecord[] = [];
	for (const name of names) {
		const dir = path.join(runsDir, name);
		try {
			if (!(await stat(dir)).isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}
		const record = await readRun(dir, name);
		if (record) {
			records.push(record);
		}
	}
	records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : b.name.localeCompare(a.name)));
	return records;
}

async function readRun(dir: string, name: string): Promise<RunRecord | null> {
	const kind = kindFromName(name);
	const file = kind === 'evals' ? 'results.json' : 'summary.json';
	let summary: Record<string, unknown>;
	try {
		const raw: unknown = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
		if (!raw || typeof raw !== 'object') {
			return null;
		}
		summary = raw as Record<string, unknown>;
	} catch {
		return null;
	}

	const startedAt = text(summary.startedAt) ?? startFromName(name) ?? new Date(0).toISOString();
	const usage = readUsage(summary.usage);
	const steps = typeof summary.steps === 'number' ? summary.steps : null;
	let durationMs = typeof summary.durationMs === 'number' ? summary.durationMs : null;
	if (durationMs === null && kind !== 'evals') {
		durationMs = await durationFromTrace(dir);
	}
	const failure = text(summary.failure);

	let outcome: string | null = null;
	if (kind === 'evals') {
		const cases = [...(Array.isArray(summary.review) ? summary.review : []), ...(Array.isArray(summary.research) ? summary.research : [])];
		const passed = cases.filter((entry) => isRecord(entry) && isRecord(entry.score) && entry.score.pass === true).length;
		outcome = `${passed}/${cases.length} cases`;
	} else if (failure) {
		outcome = `failed: ${failure}`;
	} else {
		outcome = text(summary.verdict) ?? null;
	}

	return {
		name,
		dir,
		kind: isKind(summary.kind) ? summary.kind : kind,
		startedAt,
		client: text(summary.client) ?? text(summary.clientName) ?? clientFromName(name),
		model: text(summary.model) ?? null,
		steps,
		usage,
		cost: typeof summary.cost === 'number' ? summary.cost : null,
		durationMs,
		outcome,
		failed: failure !== undefined,
	};
}

/** Adds up the runs: totals and one line per kind, in a fixed order, kinds with no runs left out. */
export function summarizeRuns(records: RunRecord[]): RunsSummary {
	const kinds: KindSummary[] = [];
	for (const kind of KINDS) {
		const runs = records.filter((record) => record.kind === kind);
		if (runs.length === 0) {
			continue;
		}
		const durations = runs.map((record) => record.durationMs).filter((value): value is number => value !== null);
		const costs = runs.map((record) => record.cost).filter((value): value is number => value !== null);
		kinds.push({
			kind,
			runs: runs.length,
			failed: runs.filter((record) => record.failed).length,
			averageDurationMs: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
			averageCost: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null,
			totalCost: costs.reduce((sum, value) => sum + value, 0),
			usage: addUsages(runs.map((record) => record.usage)),
		});
	}
	return {
		runs: records.length,
		failed: records.filter((record) => record.failed).length,
		totalCost: kinds.reduce((sum, entry) => sum + entry.totalCost, 0),
		unpriced: records.filter((record) => record.cost === null && record.usage !== null && record.usage.requests > 0).length,
		usage: addUsages(records.map((record) => record.usage)),
		kinds,
	};
}

/** The `runs` command's output: a table of runs, newest first, and the totals. */
export function renderRunsTable(records: RunRecord[], summary: RunsSummary, options: { limit?: number } = {}): string[] {
	const shown = options.limit ? records.slice(0, options.limit) : records;
	const rows = shown.map((record) => [
		formatStart(record.startedAt),
		record.kind,
		record.client ?? '-',
		record.model ?? '-',
		record.steps === null ? '-' : String(record.steps),
		record.durationMs === null ? '-' : formatDuration(record.durationMs),
		formatCost(record.cost),
		record.outcome ?? '-',
	]);
	const header = ['Started', 'Kind', 'Client', 'Model', 'Steps', 'Time', 'Cost', 'Outcome'];
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)));
	const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();

	const lines = [line(header), ...rows.map(line)];
	if (shown.length < records.length) {
		lines.push(`... and ${records.length - shown.length} more`);
	}
	lines.push('');
	for (const entry of summary.kinds) {
		const parts = [`${entry.runs} run${entry.runs === 1 ? '' : 's'}`];
		if (entry.failed > 0) {
			parts.push(`${entry.failed} failed`);
		}
		if (entry.averageDurationMs !== null) {
			parts.push(`avg ${formatDuration(entry.averageDurationMs)}`);
		}
		if (entry.averageCost !== null) {
			parts.push(`avg ${formatCost(entry.averageCost)}`);
		}
		parts.push(`${formatTokens(entry.usage.inputTokens + entry.usage.cacheReadTokens)} tokens in, ${formatTokens(entry.usage.outputTokens)} out`);
		lines.push(`${entry.kind.padEnd(9)} ${parts.join(', ')}`);
	}
	const total = [`${summary.runs} run${summary.runs === 1 ? '' : 's'}`, `${summary.usage.requests} requests`, `cost ${formatCost(summary.totalCost)}`];
	if (summary.unpriced > 0) {
		lines.push(`total     ${total.join(', ')} (${summary.unpriced} run${summary.unpriced === 1 ? '' : 's'} on a model with no price, not counted)`);
	} else {
		lines.push(`total     ${total.join(', ')}`);
	}
	return lines;
}

/** `12 s`, `5.6 min`, `1.2 h` */
export function formatDuration(ms: number): string {
	if (ms < 60_000) {
		return `${Math.round(ms / 1000)} s`;
	}
	if (ms < 3_600_000) {
		return `${(ms / 60_000).toFixed(1)} min`;
	}
	return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function formatCost(cost: number | null): string {
	if (cost === null) {
		return 'n/a';
	}
	return `~$${cost.toFixed(cost < 0.01 && cost > 0 ? 4 : 2)}`;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 10_000) {
		return `${Math.round(count / 1000)}k`;
	}
	return count.toLocaleString('en-US');
}

function formatStart(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-(.*)$/;

function kindFromName(name: string): RunKind {
	const rest = NAME.exec(name)?.[7] ?? name;
	if (rest === 'evals') {
		return 'evals';
	}
	if (rest.endsWith('-pipeline')) {
		return 'pipeline';
	}
	if (/-proposal(-v\d+)?$/.test(rest)) {
		return 'proposal';
	}
	if (/-review(-v\d+)?$/.test(rest)) {
		return 'review';
	}
	return 'research';
}

function clientFromName(name: string): string | null {
	const rest = NAME.exec(name)?.[7];
	if (!rest || rest === 'evals') {
		return null;
	}
	return rest.replace(/-(pipeline|proposal|review)(-v\d+)?$/, '');
}

/** The folder name carries the local start time: `2026-09-30-180539-...`. */
function startFromName(name: string): string | undefined {
	const match = NAME.exec(name);
	if (!match) {
		return undefined;
	}
	const [, year, month, day, hour, minute, second] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Older runs did not record a duration: the steps and their tool calls in trace.jsonl add up to one. */
async function durationFromTrace(dir: string): Promise<number | null> {
	let lines: string[];
	try {
		lines = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8')).split('\n').filter((line) => line.trim());
	} catch {
		return null;
	}
	let total = 0;
	for (const line of lines) {
		try {
			const step: unknown = JSON.parse(line);
			if (!isRecord(step)) {
				continue;
			}
			total += typeof step.durationMs === 'number' ? step.durationMs : 0;
			if (Array.isArray(step.toolCalls)) {
				for (const call of step.toolCalls) {
					total += isRecord(call) && typeof call.durationMs === 'number' ? call.durationMs : 0;
				}
			}
		} catch {
			// A broken line does not spoil the rest.
		}
	}
	return lines.length > 0 ? total : null;
}

function readUsage(value: unknown): UsageTotals | null {
	if (!isRecord(value)) {
		return null;
	}
	const number = (key: string) => (typeof value[key] === 'number' ? value[key] : 0);
	return {
		requests: number('requests'),
		inputTokens: number('inputTokens'),
		outputTokens: number('outputTokens'),
		cacheReadTokens: number('cacheReadTokens'),
		cacheWriteTokens: number('cacheWriteTokens'),
	};
}

function addUsages(usages: (UsageTotals | null)[]): UsageTotals {
	const total = emptyUsage();
	for (const usage of usages) {
		if (!usage) {
			continue;
		}
		total.requests += usage.requests;
		total.inputTokens += usage.inputTokens;
		total.outputTokens += usage.outputTokens;
		total.cacheReadTokens += usage.cacheReadTokens;
		total.cacheWriteTokens += usage.cacheWriteTokens;
	}
	return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is RunKind {
	return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}
