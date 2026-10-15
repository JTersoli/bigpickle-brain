import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { LoopDeps, Message } from '../src/loop.ts';
import { createBrainServer, parseJobRequest, type BrainServer, type Job } from '../src/server.ts';
import { sampleProposal } from './proposal.test.ts';
import { sampleReport } from './report.test.ts';
import { sampleReview } from './review.test.ts';

let dir: string;
let brain: BrainServer | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'brain-server-'));
	await mkdir(path.join(dir, 'knowledge'), { recursive: true });
	await writeFile(path.join(dir, 'knowledge', 'services.md'), '# Services (AUD)\n\n| Servicio | Precio |\n|---|---|\n| Sitio web de hasta 5 páginas | $1.000 – $1.500 |\n| Chat con IA en el sitio web | $300 – $500 |\n', 'utf8');
});

afterEach(async () => {
	await brain?.close();
	brain = undefined;
	await rm(dir, { recursive: true, force: true });
});

function reply(content: unknown[]): Message {
	return {
		id: 'msg',
		type: 'message',
		role: 'assistant',
		model: 'fake-model',
		content,
		stop_reason: 'tool_use',
		stop_sequence: null,
		stop_details: null,
		usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	} as unknown as Message;
}

function fakeDeps(replies: Message[]): LoopDeps {
	return {
		async createMessage() {
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

/** One full pipeline: research, proposal and an approving review. */
function pipelineReplies(): Message[] {
	return [
		reply([{ type: 'tool_use', id: 'tu_1', name: 'submit_research', input: sampleReport }]),
		reply([{ type: 'tool_use', id: 'tu_2', name: 'submit_proposal', input: sampleProposal }]),
		reply([{ type: 'tool_use', id: 'tu_3', name: 'submit_review', input: sampleReview }]),
	];
}

async function start(options: { token?: string; replies?: Message[] } = {}): Promise<string> {
	const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir, BRAIN_RUNS_DIR: path.join(dir, 'runs') }, dir);
	brain = createBrainServer({ config, token: options.token, deps: fakeDeps(options.replies ?? pipelineReplies()), now: () => new Date(2026, 9, 10, 12, 0, 0) });
	const address = await brain.listen('127.0.0.1', 0);
	return `http://127.0.0.1:${address.port}`;
}

async function body<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

/** Reads the event stream to its end and splits it into log lines and the final job. */
async function readEvents(url: string, headers: Record<string, string> = {}): Promise<{ lines: string[]; done: Job | undefined }> {
	const response = await fetch(url, { headers });
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('text/event-stream');
	const text = await response.text();
	const lines: string[] = [];
	let done: Job | undefined;
	for (const block of text.split('\n\n')) {
		const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
		if (data === undefined) {
			continue;
		}
		if (block.includes('event: done')) {
			done = (JSON.parse(data) as { job: Job }).job;
		} else {
			lines.push(JSON.parse(data) as string);
		}
	}
	return { lines, done };
}

describe('the server', () => {
	it('serves the page, the status and the empty runs list', async () => {
		const base = await start();

		const page = await fetch(base);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
		expect(await page.text()).toContain('<title>bigpickle-brain</title>');
		expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect((await fetch(`${base}/app.css`)).status).toBe(200);
		expect((await fetch(`${base}/nope`)).status).toBe(404);

		const status = await body<{ provider: string; dirs: { runs: string } }>(await fetch(`${base}/api/status`));
		expect(status).toMatchObject({ version: '1.0.0', model: 'claude-opus-5-5', local: false, auth: false, maxRevisions: 1, queue: { running: null, queued: 0 } });
		expect(status.provider).toBe('claude-opus-5-5 on the Claude API');
		expect(status.dirs.runs).toBe(path.join(dir, 'runs'));

		const runs = await (await fetch(`${base}/api/runs`)).json();
		expect(runs).toEqual({ runs: [], summary: { runs: 0, failed: 0, totalCost: 0, unpriced: 0, usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, kinds: [] } });
	});

	it('runs a pipeline from a POST, streams its log, lists the run and serves its notes', async () => {
		const base = await start();

		const accepted = await fetch(`${base}/api/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ brief: "Gina's Bakery, panadería en Bondi. Sin web.", clientName: "Gina's Bakery", language: 'es', revisions: '0' }),
		});
		expect(accepted.status).toBe(202);
		const { job } = (await accepted.json()) as { job: Job };
		expect(job).toMatchObject({ kind: 'pipeline', clientName: "Gina's Bakery", language: 'es', revisions: 0 });
		expect(['queued', 'running']).toContain(job.status);

		const { lines, done } = await readEvents(`${base}/api/jobs/${job.id}/events`);
		expect(lines).toContain('stage 1 of 3: research');
		expect(lines).toContain('stage 2 of 3: proposal');
		expect(lines).toContain('stage 3 of 3: review');
		expect(lines).toContain('verdict: approve (0 high, 0 medium, 1 low)');
		expect(done?.status).toBe('done');
		expect(done?.result).toMatchObject({
			verdict: 'approve',
			findings: { high: 0, medium: 0, low: 1 },
			totals: { min: 1300, max: 2000 },
			currency: 'AUD',
			verdicts: ['approve'],
			steps: 3,
			fetches: 0,
			cost: null,
		});
		expect(done?.result?.usage.requests).toBe(3);
		expect(path.basename(done?.result?.proposalPath ?? '')).toBe("2026-10-10 Propuesta Gina's Bakery.md");
		expect(path.basename(done?.result?.runDir ?? '')).toBe('2026-10-10-120000-gina-s-bakery-pipeline');

		// A late subscriber gets the whole log again and the end.
		const replay = await readEvents(`${base}/api/jobs/${job.id}/events`);
		expect(replay.lines).toEqual(lines);
		expect(replay.done?.status).toBe('done');

		const detail = (await (await fetch(`${base}/api/jobs/${job.id}`)).json()) as { job: Job };
		expect(detail.job.status).toBe('done');
		expect(detail.job.lines).toEqual(lines);
		const list = (await (await fetch(`${base}/api/jobs`)).json()) as { jobs: { id: string; lines: number }[] };
		expect(list.jobs).toHaveLength(1);
		expect(list.jobs[0]?.lines).toBe(lines.length);

		// The runs folder now holds the pipeline and its three stages, and the metrics add them up.
		const runs = await body<{ runs: { kind: string }[]; summary: { runs: number; kinds: { kind: string }[] } }>(await fetch(`${base}/api/runs`));
		expect(runs.runs.map((run: { kind: string }) => run.kind).sort()).toEqual(['pipeline', 'proposal', 'research', 'review']);
		expect(runs.summary.runs).toBe(4);
		expect(runs.summary.kinds.find((kind: { kind: string }) => kind.kind === 'pipeline')).toMatchObject({ runs: 1, failed: 0 });
		const run = await body<{ summary: unknown }>(await fetch(`${base}/api/runs/2026-10-10-120000-gina-s-bakery-pipeline`));
		expect(run.summary).toMatchObject({ kind: 'pipeline', client: "Gina's Bakery", verdict: 'approve', steps: 3 });
		expect((await fetch(`${base}/api/runs/2026-10-10-120000-nope`)).status).toBe(404);
		expect((await fetch(`${base}/api/runs/..%2F..%2Fetc`)).status).toBe(400);

		// Notes are served from the data folders only, by their real path.
		const proposalPath = done?.result?.proposalPath ?? '';
		const note = await body<{ text: string }>(await fetch(`${base}/api/notes?path=${encodeURIComponent(proposalPath)}`));
		expect(note.text).toBe(await readFile(proposalPath, 'utf8'));
		expect((await fetch(`${base}/api/notes?path=${encodeURIComponent(path.join(dir, 'knowledge', 'services.md'))}`)).status).toBe(404);
		expect((await fetch(`${base}/api/notes?path=${encodeURIComponent(path.join(dir, 'reports', '..', 'knowledge', 'services.md'))}`)).status).toBe(404);
		expect((await fetch(`${base}/api/notes?path=${encodeURIComponent(path.join(dir, 'reports', 'missing.md'))}`)).status).toBe(404);
	});

	it('rejects bad job requests before they reach a model', async () => {
		const base = await start();
		const post = (body: string, type = 'application/json') => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': type }, body });

		expect(await (await post('{"brief": ""}')).json()).toEqual({ error: 'brief is required.' });
		expect(await (await post('{"brief": "x", "kind": "evals"}')).json()).toEqual({ error: 'kind must be "pipeline" or "research".' });
		expect(await (await post('{"brief": "x", "language": "fr"}')).json()).toEqual({ error: 'language must be "es", "en" or empty.' });
		expect(await (await post('{"brief": "x", "revisions": 9}')).json()).toEqual({ error: 'revisions must be an integer from 0 to 5.' });
		expect(await (await post('not json')).json()).toEqual({ error: 'The body is not valid JSON.' });
		expect((await post('brief=x', 'text/plain')).status).toBe(400);
		expect((await post(`{"brief": "${'x'.repeat(70_000)}"}`)).status).toBe(400);
		expect((await fetch(`${base}/api/jobs/nope`)).status).toBe(404);

		const crossSite = await fetch(`${base}/api/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
		expect(crossSite.status).toBe(403);
		expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
	});

	it('reports a failed run as a failed job, with the trace saved', async () => {
		const base = await start({ replies: [] });
		const accepted = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: 'Acme, hardware store.', kind: 'research' }) });
		const { job } = (await accepted.json()) as { job: Job };
		expect(job.revisions).toBeUndefined();

		const { lines, done } = await readEvents(`${base}/api/jobs/${job.id}/events`);
		expect(done?.status).toBe('failed');
		expect(done?.error).toBe('No more fake replies');
		expect(lines.at(-1)).toBe('error: No more fake replies');
	});

	it('runs jobs one at a time, in order', async () => {
		const base = await start({ replies: [...pipelineReplies(), ...pipelineReplies()] });
		const post = () => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: "Gina's Bakery.", clientName: "Gina's Bakery", revisions: 0 }) });
		const first = ((await (await post()).json()) as { job: Job }).job;
		const second = ((await (await post()).json()) as { job: Job }).job;
		const status = await body<{ queue: { running: string | null; queued: number } }>(await fetch(`${base}/api/status`));
		expect(status.queue.running).toBe(first.id);
		expect(status.queue.queued).toBe(1);

		const [a, b] = await Promise.all([readEvents(`${base}/api/jobs/${first.id}/events`), readEvents(`${base}/api/jobs/${second.id}/events`)]);
		expect(a.done?.status).toBe('done');
		expect(b.done?.status).toBe('done');
		expect(a.done?.finishedAt && b.done?.startedAt && a.done.finishedAt <= b.done.startedAt).toBe(true);
	});

	it('requires the token on the API when one is set, and refuses to listen beyond localhost without one', async () => {
		const base = await start({ token: 'secret-token' });
		expect((await fetch(`${base}/`)).status).toBe(200);
		expect((await fetch(`${base}/api/status`)).status).toBe(401);
		expect((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
		expect((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer secret-token' } })).status).toBe(200);

		const accepted = await fetch(`${base}/api/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
			body: JSON.stringify({ brief: "Gina's Bakery.", clientName: "Gina's Bakery", revisions: 0 }),
		});
		const { job } = (await accepted.json()) as { job: Job };
		// The browser's EventSource cannot send headers, so the stream takes the token as a query parameter.
		expect((await fetch(`${base}/api/jobs/${job.id}/events`)).status).toBe(401);
		const { done } = await readEvents(`${base}/api/jobs/${job.id}/events?token=secret-token`);
		expect(done?.status).toBe('done');

		await brain?.close();
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', BRAIN_DATA_DIR: dir }, dir);
		brain = createBrainServer({ config, deps: fakeDeps([]) });
		expect(() => brain?.listen('0.0.0.0', 0)).toThrow(ConfigError);
	});
});

describe('parseJobRequest', () => {
	const config = { maxRevisions: 2 };

	it('fills the defaults and trims the text', () => {
		expect(parseJobRequest({ brief: '  Acme.  ' }, config)).toEqual({ value: { kind: 'pipeline', brief: 'Acme.', clientName: undefined, language: undefined, revisions: 2 } });
		expect(parseJobRequest({ brief: 'Acme.', kind: 'research', clientName: ' Acme ', language: 'en', revisions: '1' }, config)).toEqual({
			value: { kind: 'research', brief: 'Acme.', clientName: 'Acme', language: 'en', revisions: undefined },
		});
		expect(parseJobRequest({ brief: 'Acme.', revisions: '' }, config)).toEqual({ value: { kind: 'pipeline', brief: 'Acme.', clientName: undefined, language: undefined, revisions: 2 } });
	});

	it('refuses what it cannot run', () => {
		expect(parseJobRequest(null, config)).toEqual({ error: 'Send a JSON object.' });
		expect(parseJobRequest([], config)).toEqual({ error: 'Send a JSON object.' });
		expect(parseJobRequest({ brief: 'x', clientName: 'c'.repeat(121) }, config)).toEqual({ error: 'clientName is over 120 characters.' });
		expect(parseJobRequest({ brief: 'x', revisions: 1.5 }, config)).toEqual({ error: 'revisions must be an integer from 0 to 5.' });
	});
});
