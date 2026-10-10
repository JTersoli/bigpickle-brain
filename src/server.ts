import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ReportLanguage } from './agents/research.ts';
import type { Verdict } from './agents/review.ts';
import { countFindings } from './checks.ts';
import { ConfigError, describeProvider, type BrainConfig } from './config.ts';
import { AgentRunError, type LoopDeps } from './loop.ts';
import { listRuns, summarizeRuns } from './metrics.ts';
import { runPipeline } from './pipeline.ts';
import { estimateCost, type UsageTotals } from './pricing.ts';
import { describeError } from './provider.ts';
import { runResearch } from './run.ts';

export const SERVER_VERSION = '0.5.0';

export type JobKind = 'pipeline' | 'research';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRequest {
	kind: JobKind;
	brief: string;
	clientName?: string;
	language?: ReportLanguage;
	/** Pipeline only: rewrites allowed. Defaults to the configured value. */
	revisions?: number;
}

/** What a finished job hands back: the notes it wrote and the numbers of the run. */
export interface JobResult {
	runDir: string;
	reportPath: string;
	proposalPath?: string;
	reviewPath?: string;
	memoryPath: string;
	verdict?: Verdict;
	findings?: { high: number; medium: number; low: number };
	totals?: { min: number; max: number };
	currency?: string;
	/** Pipeline: the verdict of every version, first draft first. */
	verdicts?: Verdict[];
	steps: number;
	fetches: number;
	durationMs: number;
	usage: UsageTotals;
	cost: number | null;
}

export interface Job {
	id: string;
	kind: JobKind;
	brief: string;
	clientName?: string;
	language?: ReportLanguage;
	revisions?: number;
	status: JobStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	/** The log lines the stages printed, in order. */
	lines: string[];
	result?: JobResult;
	error?: string;
}

export interface ServerOptions {
	config: BrainConfig;
	/** When set, every /api request must carry it as a bearer token (or `?token=` for the event stream). */
	token?: string;
	log?: (line: string) => void;
	/** Replaces the real API client, for tests. */
	deps?: LoopDeps;
	/** Replaces the real fetch behind `fetch_url`, for tests. */
	fetchImpl?: typeof fetch;
	now?: () => Date;
	/** How many finished jobs stay in memory (the runs folder keeps everything). Default 50. */
	keepJobs?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BRIEF_CHARS = 20_000;
const MAX_CLIENT_CHARS = 120;
const MAX_REVISIONS = 5;
const HEARTBEAT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type Listener = (line: string | null) => void;

/**
 * Runs jobs one at a time, in order: every job is a full agent run that costs money and writes to the
 * same memory, so two at once would race on the client notes and double the bill.
 */
export class JobQueue {
	private readonly jobs = new Map<string, Job>();
	private readonly listeners = new Map<string, Set<Listener>>();
	private readonly pending: string[] = [];
	private running: string | null = null;
	private closed = false;
	private readonly options: ServerOptions;

	constructor(options: ServerOptions) {
		this.options = options;
	}

	get current(): string | null {
		return this.running;
	}

	get queued(): number {
		return this.pending.length;
	}

	list(): Job[] {
		return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	/** Accepts the job and starts it when the queue is free. */
	add(request: JobRequest): Job {
		if (this.closed) {
			throw new Error('The server is shutting down and takes no new jobs.');
		}
		const now = this.options.now ?? (() => new Date());
		const job: Job = {
			id: randomUUID().slice(0, 8),
			kind: request.kind,
			brief: request.brief,
			clientName: request.clientName,
			language: request.language,
			revisions: request.revisions,
			status: 'queued',
			createdAt: now().toISOString(),
			lines: [],
		};
		this.jobs.set(job.id, job);
		this.pending.push(job.id);
		this.trim();
		void this.next();
		return job;
	}

	/** Receives every line already logged, then the new ones; `null` means the job finished. Returns the unsubscribe. */
	subscribe(id: string, listener: Listener): () => void {
		const job = this.jobs.get(id);
		if (!job) {
			return () => undefined;
		}
		for (const line of job.lines) {
			listener(line);
		}
		if (job.status === 'done' || job.status === 'failed') {
			listener(null);
			return () => undefined;
		}
		let set = this.listeners.get(id);
		if (!set) {
			set = new Set();
			this.listeners.set(id, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	/** Stops taking jobs. The running one finishes; the queued ones are dropped. */
	close(): void {
		this.closed = true;
		for (const id of this.pending.splice(0)) {
			const job = this.jobs.get(id);
			if (job) {
				this.finish(job, 'failed', 'The server shut down before this job started.');
			}
		}
	}

	private async next(): Promise<void> {
		if (this.running !== null) {
			return;
		}
		const id = this.pending.shift();
		if (id === undefined) {
			return;
		}
		const job = this.jobs.get(id);
		if (!job) {
			void this.next();
			return;
		}
		this.running = id;
		const now = this.options.now ?? (() => new Date());
		job.status = 'running';
		job.startedAt = now().toISOString();
		const log = (line: string) => {
			job.lines.push(line);
			this.options.log?.(`[${job.id}] ${line}`);
			this.emit(id, line);
		};
		try {
			job.result = await this.run(job, log);
			this.finish(job, 'done');
		} catch (error) {
			const message = error instanceof AgentRunError ? `The run failed (${error.reason}): ${error.message}` : describeError(error);
			log(`error: ${message}`);
			this.finish(job, 'failed', message);
		} finally {
			this.running = null;
			void this.next();
		}
	}

	private async run(job: Job, log: (line: string) => void): Promise<JobResult> {
		const { config, deps, fetchImpl, now } = this.options;
		if (job.kind === 'research') {
			const outcome = await runResearch({ brief: job.brief, clientName: job.clientName, language: job.language, config, log, deps, fetchImpl, now });
			return {
				runDir: outcome.runDir,
				reportPath: outcome.reportPath,
				memoryPath: outcome.memoryPath,
				steps: outcome.result.steps.length,
				fetches: outcome.fetches,
				durationMs: outcome.result.durationMs,
				usage: outcome.result.usage,
				cost: estimateCost(outcome.result.model, outcome.result.usage),
			};
		}
		const outcome = await runPipeline({ brief: job.brief, clientName: job.clientName, language: job.language, maxRevisions: job.revisions, config, log, deps, now });
		const steps = outcome.research.result.steps.length + outcome.attempts.reduce((sum, attempt) => sum + attempt.proposal.result.steps.length + attempt.review.result.steps.length, 0);
		return {
			runDir: outcome.runDir,
			reportPath: outcome.research.reportPath,
			proposalPath: outcome.proposal.proposalPath,
			reviewPath: outcome.review.reviewPath,
			memoryPath: outcome.proposal.memoryPath,
			verdict: outcome.review.verdict,
			findings: countFindings(outcome.review.findings),
			totals: { min: outcome.proposal.totals.min, max: outcome.proposal.totals.max },
			currency: outcome.proposal.proposal.investment.currency || 'AUD',
			verdicts: outcome.attempts.map((attempt) => attempt.review.verdict),
			steps,
			fetches: outcome.research.fetches,
			durationMs: outcome.durationMs,
			usage: outcome.usage,
			cost: outcome.cost,
		};
	}

	private finish(job: Job, status: 'done' | 'failed', error?: string): void {
		const now = this.options.now ?? (() => new Date());
		job.status = status;
		job.finishedAt = now().toISOString();
		if (error) {
			job.error = error;
		}
		this.emit(job.id, null);
		this.listeners.delete(job.id);
	}

	private emit(id: string, line: string | null): void {
		for (const listener of this.listeners.get(id) ?? []) {
			listener(line);
		}
	}

	/** Forgets the oldest finished jobs beyond the limit. */
	private trim(): void {
		const keep = this.options.keepJobs ?? 50;
		const finished = this.list().filter((job) => job.status === 'done' || job.status === 'failed');
		for (const job of finished.slice(keep)) {
			this.jobs.delete(job.id);
		}
	}
}

export interface BrainServer {
	server: Server;
	queue: JobQueue;
	/** Binds the port. Rejects a non-loopback host without a token. */
	listen(host: string, port: number): Promise<AddressInfo>;
	/** Stops accepting connections and jobs. The running job, if any, finishes on its own. */
	close(): Promise<void>;
}

/** The minimal interface: a page to start runs and watch them, and a JSON API over the same queue and the runs folder. */
export function createBrainServer(options: ServerOptions): BrainServer {
	const queue = new JobQueue(options);
	const assets = loadAssets();
	const server = createServer((request, response) => {
		handle(request, response, options, queue, assets).catch((error: unknown) => {
			options.log?.(`error: ${describeError(error)}`);
			if (!response.headersSent) {
				sendJson(response, 500, { error: 'Internal error.' });
			} else {
				response.end();
			}
		});
	});
	server.keepAliveTimeout = 5_000;

	return {
		server,
		queue,
		listen(host, port) {
			if (!LOOPBACK_HOSTS.has(host) && !options.token) {
				throw new ConfigError(`Binding to ${host} exposes the server beyond this machine, and every run costs money: set BRAIN_SERVER_TOKEN first.`);
			}
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => {
					server.off('error', reject);
					resolve(server.address() as AddressInfo);
				});
			});
		},
		close() {
			queue.close();
			return new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}

type Assets = Promise<Map<string, { type: string; body: Buffer }>>;

function loadAssets(): Assets {
	const dir = path.join(import.meta.dirname, 'ui');
	const files: [string, string, string][] = [
		['/', 'index.html', 'text/html; charset=utf-8'],
		['/app.css', 'app.css', 'text/css; charset=utf-8'],
		['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
	];
	return Promise.all(files.map(async ([route, file, type]) => [route, { type, body: await readFile(path.join(dir, file)) }] as const)).then((entries) => new Map(entries));
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ServerOptions, queue: JobQueue, assets: Assets): Promise<void> {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const method = request.method ?? 'GET';
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('Referrer-Policy', 'no-referrer');

	if (!url.pathname.startsWith('/api/')) {
		if (method !== 'GET' && method !== 'HEAD') {
			sendJson(response, 405, { error: 'Method not allowed.' });
			return;
		}
		const asset = (await assets).get(url.pathname);
		if (!asset) {
			sendJson(response, 404, { error: 'Not found.' });
			return;
		}
		response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
		response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
		response.end(method === 'HEAD' ? undefined : asset.body);
		return;
	}

	response.setHeader('Cache-Control', 'no-store');
	if (options.token && !authorized(request, url, options.token)) {
		sendJson(response, 401, { error: 'A bearer token is required.' });
		return;
	}
	// Browsers mark requests from other sites; nothing here is meant for them.
	const site = request.headers['sec-fetch-site'];
	if (site === 'cross-site') {
		sendJson(response, 403, { error: 'Cross-site requests are not accepted.' });
		return;
	}

	const route = `${method} ${url.pathname}`;
	if (route === 'GET /api/status') {
		const { config } = options;
		sendJson(response, 200, {
			version: SERVER_VERSION,
			provider: describeProvider(config),
			model: config.model,
			local: config.local,
			effort: config.effort,
			maxRevisions: config.maxRevisions,
			auth: Boolean(options.token),
			dirs: { knowledge: config.knowledgeDir, clients: config.clientsDir, reports: config.reportsDir, proposals: config.proposalsDir, reviews: config.reviewsDir, runs: config.runsDir },
			queue: { running: queue.current, queued: queue.queued },
		});
		return;
	}

	if (route === 'GET /api/runs') {
		const runs = await listRuns(options.config.runsDir);
		const limit = Number(url.searchParams.get('limit') ?? '0');
		sendJson(response, 200, { runs: limit > 0 ? runs.slice(0, limit) : runs, summary: summarizeRuns(runs) });
		return;
	}

	const runMatch = /^GET \/api\/runs\/([^/]+)$/.exec(route);
	if (runMatch) {
		const name = decodeURIComponent(runMatch[1] ?? '');
		if (!/^[\w.-]+$/.test(name)) {
			sendJson(response, 400, { error: 'Bad run name.' });
			return;
		}
		const dir = path.join(options.config.runsDir, name);
		const file = name.endsWith('-evals') ? 'results.json' : 'summary.json';
		try {
			const summary: unknown = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
			sendJson(response, 200, { name, dir, summary });
		} catch {
			sendJson(response, 404, { error: 'No such run.' });
		}
		return;
	}

	if (route === 'GET /api/notes') {
		const requested = url.searchParams.get('path') ?? '';
		const note = await readNote(requested, options.config);
		if (!note) {
			sendJson(response, 404, { error: 'No such note, or the file is outside the data folders.' });
			return;
		}
		sendJson(response, 200, note);
		return;
	}

	if (route === 'GET /api/jobs') {
		sendJson(response, 200, { jobs: queue.list().map(({ lines, ...job }) => ({ ...job, lines: lines.length })) });
		return;
	}

	if (route === 'POST /api/jobs') {
		const body = await readJsonBody(request);
		if ('error' in body) {
			sendJson(response, 400, { error: body.error });
			return;
		}
		const parsed = parseJobRequest(body.value, options.config);
		if ('error' in parsed) {
			sendJson(response, 400, { error: parsed.error });
			return;
		}
		try {
			const job = queue.add(parsed.value);
			options.log?.(`[${job.id}] queued: ${job.kind} for ${job.clientName ?? 'the business in the brief'}`);
			sendJson(response, 202, { job });
		} catch (error) {
			sendJson(response, 503, { error: describeError(error) });
		}
		return;
	}

	const jobMatch = /^GET \/api\/jobs\/([\w-]+)(\/events)?$/.exec(route);
	if (jobMatch) {
		const job = queue.get(jobMatch[1] ?? '');
		if (!job) {
			sendJson(response, 404, { error: 'No such job.' });
			return;
		}
		if (!jobMatch[2]) {
			sendJson(response, 200, { job });
			return;
		}
		streamJob(request, response, queue, job);
		return;
	}

	sendJson(response, 404, { error: 'Not found.' });
}

/** Server-sent events: the lines so far, then each new one, then `done` with the finished job. */
function streamJob(request: IncomingMessage, response: ServerResponse, queue: JobQueue, job: Job): void {
	response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
	response.write(`retry: 2000\n\n`);
	const heartbeat = setInterval(() => response.write(': ping\n\n'), HEARTBEAT_MS);
	const unsubscribe = queue.subscribe(job.id, (line) => {
		if (line === null) {
			response.write(`event: done\ndata: ${JSON.stringify({ job })}\n\n`);
			clearInterval(heartbeat);
			response.end();
			return;
		}
		response.write(`data: ${JSON.stringify(line)}\n\n`);
	});
	request.on('close', () => {
		clearInterval(heartbeat);
		unsubscribe();
	});
}

function authorized(request: IncomingMessage, url: URL, token: string): boolean {
	const header = request.headers.authorization;
	const given = header?.startsWith('Bearer ') ? header.slice(7).trim() : (url.searchParams.get('token') ?? '');
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(request: IncomingMessage): Promise<{ value: unknown } | { error: string }> {
	const type = request.headers['content-type'] ?? '';
	if (!/^application\/json\b/i.test(type)) {
		return { error: 'Send JSON with Content-Type: application/json.' };
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			return { error: `The body is over ${MAX_BODY_BYTES / 1024} KB.` };
		}
		chunks.push(buffer);
	}
	try {
		return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
	} catch {
		return { error: 'The body is not valid JSON.' };
	}
}

/** Validates what the page or a client sends. Everything here reaches a model and a file name, so it is checked here, not trusted. */
export function parseJobRequest(value: unknown, config: Pick<BrainConfig, 'maxRevisions'>): { value: JobRequest } | { error: string } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { error: 'Send a JSON object.' };
	}
	const body = value as Record<string, unknown>;
	const kind = body.kind ?? 'pipeline';
	if (kind !== 'pipeline' && kind !== 'research') {
		return { error: 'kind must be "pipeline" or "research".' };
	}
	const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
	if (!brief) {
		return { error: 'brief is required.' };
	}
	if (brief.length > MAX_BRIEF_CHARS) {
		return { error: `brief is over ${MAX_BRIEF_CHARS.toLocaleString('en-US')} characters.` };
	}
	const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
	if (clientName.length > MAX_CLIENT_CHARS) {
		return { error: `clientName is over ${MAX_CLIENT_CHARS} characters.` };
	}
	const language = body.language ?? '';
	if (language !== '' && language !== 'es' && language !== 'en') {
		return { error: 'language must be "es", "en" or empty.' };
	}
	let revisions: number | undefined;
	if (body.revisions !== undefined && body.revisions !== null && body.revisions !== '') {
		const number = Number(body.revisions);
		if (!Number.isInteger(number) || number < 0 || number > MAX_REVISIONS) {
			return { error: `revisions must be an integer from 0 to ${MAX_REVISIONS}.` };
		}
		revisions = number;
	}
	return {
		value: {
			kind,
			brief,
			clientName: clientName || undefined,
			language: language === '' ? undefined : language,
			revisions: kind === 'pipeline' ? (revisions ?? config.maxRevisions) : undefined,
		},
	};
}

/** Reads a Markdown or JSON file, only from the data folders and the runs folder, by its real path. */
async function readNote(requested: string, config: BrainConfig): Promise<{ path: string; text: string } | null> {
	if (!requested || !/\.(md|json)$/i.test(requested)) {
		return null;
	}
	let file: string;
	try {
		file = await realpath(path.resolve(requested));
	} catch {
		return null;
	}
	const roots = await Promise.all([config.reportsDir, config.proposalsDir, config.reviewsDir, config.clientsDir, config.runsDir].map((dir) => realpath(dir).catch(() => null)));
	const inside = roots.some((root) => root !== null && (file === root || file.startsWith(root + path.sep)));
	if (!inside) {
		return null;
	}
	try {
		return { path: file, text: await readFile(file, 'utf8') };
	} catch {
		return null;
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(body));
}
