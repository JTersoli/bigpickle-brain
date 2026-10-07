import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProposalSchema } from '../agents/proposal.ts';
import { ResearchReportSchema, type ResearchReport } from '../agents/research.ts';
import { VERDICTS } from '../agents/review.ts';
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from '../checks.ts';

/**
 * One thing the review of a case must find. A finding matches when its category is one of the
 * expected ones (any, when none is given), its text carries one of the keywords, and its severity
 * is at least the expected one. `by: "code"` means the automated checks alone must catch it;
 * `by: "any"` means the checks or the review agent.
 */
export const ExpectedFindingSchema = z.object({
	id: z.string().min(1),
	category: z.union([z.enum(FINDING_CATEGORIES), z.array(z.enum(FINDING_CATEGORIES)).min(1)]).optional(),
	severity: z.enum(FINDING_SEVERITIES).default('low'),
	by: z.enum(['code', 'any']).default('any'),
	match: z.array(z.string().min(1)).min(1),
	note: z.string().default(''),
});

export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

export const ReviewExpectationSchema = z.object({
	/** The lowest acceptable verdict: approve means exactly approve; revise accepts reject too. */
	verdict: z.enum(VERDICTS),
	findings: z.array(ExpectedFindingSchema).default([]),
});

export type ReviewExpectation = z.infer<typeof ReviewExpectationSchema>;

const PastProposalSchema = z.object({
	client: z.string().min(1),
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	language: z.string().default('en'),
	status: z.string().default('sent'),
	currency: z.string().default('AUD'),
	total_min: z.number(),
	total_max: z.number(),
	services: z.string().default(''),
});

export type PastProposalSeed = z.infer<typeof PastProposalSchema>;

/** A review case: a proposal with planted errors (or none), the research it answers, and what the review must find. */
export const ReviewCaseSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(''),
	/** The name of a research fixture in `review/research/`, without the extension. */
	research: z.string().min(1),
	brief: z.string().default(''),
	/** Lines for the client's memory note, as the agents write them (`- 2026-09-15 (proposal): ...`). */
	clientNotes: z.array(z.string()).default([]),
	/** Proposals already in the history, written as notes the `past_proposals` tool reads. */
	pastProposals: z.array(PastProposalSchema).default([]),
	proposal: ProposalSchema,
	expected: ReviewExpectationSchema,
});

export type ReviewCaseData = z.infer<typeof ReviewCaseSchema>;

export interface ReviewCase extends ReviewCaseData {
	/** The research report the case names. */
	report: ResearchReport;
	file: string;
}

export const ResearchExpectationSchema = z.object({
	/** Facts from the pages that a report doing its job carries. */
	reportMustContain: z.array(z.string().min(1)).default([]),
	/** The planted claims. A mention counts: the next agent reads the report as facts. */
	reportMustNotContain: z.array(z.string().min(1)).default([]),
	memoryMustNotContain: z.array(z.string().min(1)).default([]),
	/** URL fragments the agent must not try to fetch, whether the code would block them or not. */
	mustNotFetch: z.array(z.string().min(1)).default([]),
	/** A string that exists only in the knowledge; in the report or the memory it means the prompt leaked. */
	canary: z.string().optional(),
});

export type ResearchExpectation = z.infer<typeof ResearchExpectationSchema>;

/** A research case: a brief, a fake website with injected instructions, and what the report may and may not carry. */
export const ResearchCaseSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(''),
	brief: z.string().min(1),
	client: z.string().optional(),
	language: z.enum(['en', 'es']).optional(),
	/** URL to the HTML file next to case.json that the fake fetch serves for it. */
	pages: z.record(z.string().url(), z.string().min(1)),
	expected: ResearchExpectationSchema,
});

export type ResearchCaseData = z.infer<typeof ResearchCaseSchema>;

export interface ResearchCase extends Omit<ResearchCaseData, 'pages'> {
	/** URL to the page's HTML. */
	pages: Record<string, string>;
	dir: string;
}

export class EvalCaseError extends Error {}

/** Loads `review/research/*.json` and `review/cases/*.json` under the evals folder. */
export async function loadReviewCases(root: string): Promise<ReviewCase[]> {
	const reports = new Map<string, ResearchReport>();
	const researchDir = path.join(root, 'review', 'research');
	for (const fileName of await listJson(researchDir)) {
		const file = path.join(researchDir, fileName);
		const parsed = ResearchReportSchema.safeParse(await readJson(file));
		if (!parsed.success) {
			throw new EvalCaseError(`${file}: not a research report (${firstIssue(parsed.error)})`);
		}
		reports.set(fileName.slice(0, -5), parsed.data);
	}

	const cases: ReviewCase[] = [];
	const casesDir = path.join(root, 'review', 'cases');
	for (const fileName of await listJson(casesDir)) {
		const file = path.join(casesDir, fileName);
		const parsed = ReviewCaseSchema.safeParse(await readJson(file));
		if (!parsed.success) {
			throw new EvalCaseError(`${file}: ${firstIssue(parsed.error)}`);
		}
		const report = reports.get(parsed.data.research);
		if (!report) {
			throw new EvalCaseError(`${file}: research "${parsed.data.research}" is not in ${researchDir} (${[...reports.keys()].join(', ') || 'empty'})`);
		}
		cases.push({ ...parsed.data, report, file });
	}
	return cases;
}

/** Loads every folder under `research/` that has a `case.json`, with its pages read. */
export async function loadResearchCases(root: string): Promise<ResearchCase[]> {
	const dir = path.join(root, 'research');
	let names: string[];
	try {
		names = (await readdir(dir)).sort();
	} catch {
		return [];
	}
	const cases: ResearchCase[] = [];
	for (const name of names) {
		const caseDir = path.join(dir, name);
		const file = path.join(caseDir, 'case.json');
		try {
			if (!(await stat(file)).isFile()) {
				continue;
			}
		} catch {
			continue;
		}
		const parsed = ResearchCaseSchema.safeParse(await readJson(file));
		if (!parsed.success) {
			throw new EvalCaseError(`${file}: ${firstIssue(parsed.error)}`);
		}
		const pages: Record<string, string> = {};
		for (const [url, pageFile] of Object.entries(parsed.data.pages)) {
			const pagePath = path.resolve(caseDir, pageFile);
			if (path.relative(caseDir, pagePath).startsWith('..')) {
				throw new EvalCaseError(`${file}: page "${pageFile}" is outside the case folder`);
			}
			try {
				pages[new URL(url).toString()] = await readFile(pagePath, 'utf8');
			} catch {
				throw new EvalCaseError(`${file}: could not read the page "${pageFile}" for ${url}`);
			}
		}
		cases.push({ ...parsed.data, pages, dir: caseDir });
	}
	return cases;
}

/** Accents, case and whitespace do not count when matching keywords. */
export function normalizeText(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

export function containsText(haystack: string, needle: string): boolean {
	const key = normalizeText(needle);
	return key.length > 0 && normalizeText(haystack).includes(key);
}

async function listJson(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
	} catch {
		return [];
	}
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as unknown;
	} catch (error) {
		throw new EvalCaseError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) {
		return 'invalid';
	}
	return `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`;
}
