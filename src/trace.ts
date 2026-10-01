import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageParam, StepRecord } from './loop.ts';
import type { UsageTotals } from './pricing.ts';
import { isoDate } from './tools/memory.ts';

/** What a run leaves behind in its folder: one line per step, the full conversation and a summary. */
export interface TraceData {
	steps: StepRecord[];
	messages: MessageParam[];
	usage: UsageTotals;
	model?: string;
	cost?: number | null;
	brief?: string;
	reportPath?: string;
	report?: unknown;
	failure?: string;
	error?: string;
}

export async function writeTrace(runDir: string, data: TraceData): Promise<void> {
	await mkdir(runDir, { recursive: true });
	const { steps, messages, ...summary } = data;
	await writeFile(path.join(runDir, 'trace.jsonl'), steps.map((step) => JSON.stringify(step)).join('\n') + '\n', 'utf8');
	await writeFile(path.join(runDir, 'messages.json'), JSON.stringify(messages, null, '\t'), 'utf8');
	await writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ ...summary, steps: steps.length }, null, '\t'), 'utf8');
}

/** `2026-09-30-180539` */
export function stamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${isoDate(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The folder for one run: `runs/2026-09-30-180539-client-slug[-suffix]`. */
export function runFolder(runsDir: string, date: Date, slug: string, suffix?: string): string {
	return path.join(runsDir, `${stamp(date)}-${slug}${suffix ? `-${suffix}` : ''}`);
}
