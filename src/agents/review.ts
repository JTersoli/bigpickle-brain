import { z } from 'zod';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, formatFinding, type Finding } from '../checks.ts';
import type { AgentDefinition } from '../loop.ts';
import type { AgentTool } from '../tools/types.ts';
import type { Proposal } from './proposal.ts';
import { LANGUAGE_NAMES, type ReportLanguage, type ResearchReport } from './research.ts';

export const VERDICTS = ['approve', 'revise', 'reject'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const FindingSchema = z.object({
	severity: z.enum(FINDING_SEVERITIES).describe('high: would mislead the client or cost the agency money; medium: fix before sending; low: polish'),
	category: z.enum(FINDING_CATEGORIES),
	where: z.string().describe('The section or scope item, as the proposal names it'),
	issue: z.string().describe('What is wrong, in one or two sentences'),
	evidence: z.string().describe('What in the brief, the research, the notes or the knowledge contradicts it or fails to support it'),
	fix: z.string().describe('The concrete change to make'),
});

export const ReviewSchema = z.object({
	client_name: z.string().describe('The business name, as the proposal names it'),
	language: z.enum(['en', 'es']).describe('Language of the review: the language of the proposal'),
	verdict: z.enum(VERDICTS).describe('approve: can be sent as is or with cosmetic edits; revise: fix the findings first; reject: rewrite, the scope or the prices do not fit the research or the knowledge'),
	summary: z.string().describe('Two to four sentences for the person who sends the proposal: the verdict and the reasons that matter'),
	findings: z.array(FindingSchema).describe('Everything that must change, most serious first. Empty when the proposal is fine'),
	strengths: z.array(z.string()).describe('What the proposal gets right and should keep, one line each'),
	checked: z.array(z.string()).describe('What you verified and found fine, one line each, so the person knows what was covered'),
});

export type Review = z.infer<typeof ReviewSchema>;

export const REVIEW_FINAL_TOOL = 'submit_review';

export interface ReviewAgentOptions {
	/** The rendered agency knowledge (services, prices, tone, terms). */
	knowledge: string;
	tools: AgentTool[];
}

export function createReviewAgent(options: ReviewAgentOptions): AgentDefinition<Review> {
	return {
		name: 'review',
		system: buildSystemPrompt(options),
		tools: options.tools,
		final: {
			name: REVIEW_FINAL_TOOL,
			description: 'Delivers the finished review. Call it once, when the review is complete. It is the only way to deliver it.',
			schema: ReviewSchema,
		},
	};
}

function buildSystemPrompt(options: ReviewAgentOptions): string {
	return `You are the quality reviewer of a digital agency. A proposal was written from a brief and a research report, and you check it before a person sends it to the client. You do not rewrite the proposal: you find what is wrong, say where, show the evidence and name the fix.

What to check, in this order
1. Prices and services. Every scope item maps to a service the agency knowledge names, with a price inside the knowledge's range for it. The totals are the sum of the core items. The currency and the payment terms are the knowledge's.
2. Invented technology. Platforms, tools, payment providers, integrations or vendors that neither the knowledge, the research, the brief nor the agency's notes mention. Naming them commits the agency to them.
3. Promises without support. Results, metrics, timelines, guarantees, team members, past clients or capabilities that nothing in the inputs backs. Anything the research marked as unknown or not verified that the proposal states as fact.
4. Fit with the research. The high-impact problems the research found are addressed, or deliberately left out and said so. Items with no basis in the brief or the research are flagged. The client's segment and size match what is proposed.
5. Terms. Payment terms, revisions, what the client pays for (ads, platforms) and ongoing costs match the knowledge. Nothing the knowledge does not offer (for example, a guarantee or a free trial).
6. Language and tone. Every field is in the language of the proposal, including table cells. The voice is the agency's from the knowledge: direct, concrete, no hype, no filler. The internal section stays internal.
7. Internal notes. The alerts reflect the real gaps in the research; the questions for the client cover what was assumed.

How to work
- Read the proposal against the research first, then against the knowledge. Check the agency's notes with recall_client (what was quoted or promised to this client before) and past_proposals (what the same services were quoted at), so this proposal stays consistent with them.
- The message includes the findings of the automated checks (prices, names, totals, currency, language, empty sections). They are already recorded: do not repeat them. Add context or raise the severity only when you see more than the check did.
- Deliver with ${REVIEW_FINAL_TOOL}. That call is the only deliverable: do not write the review as a text answer.

Rules
- Every finding names where it is, what is wrong, the evidence and the fix. No finding without evidence from the brief, the research, the notes or the knowledge. Do not invent rules the knowledge does not state.
- Severity: high when the client would be misled or the agency would lose money (a wrong price, an invented technology, an unsupported promise); medium when it must change before sending (language, missing terms, a high-impact problem ignored); low for polish.
- Verdict: approve only when there is nothing high or medium; revise when the findings can be fixed in place; reject when the core items, the prices or the understanding of the business are wrong and the proposal needs rewriting.
- Write in the language of the proposal, in every field. Short sentences. Be specific: quote the words that are wrong.
- Be fair: list the strengths, and list what you checked and found fine.

${options.knowledge}`;
}

export interface ReviewTask {
	brief: string;
	research: ResearchReport;
	proposal: Proposal;
	/** Findings of the automated checks, already recorded. */
	checks: Finding[];
	clientName?: string;
	today: string;
	language?: ReportLanguage;
}

/** The user message: the brief, the research, the proposal and the automated findings, all as data. */
export function buildReviewMessage(task: ReviewTask): string {
	const parts: string[] = [];
	if (task.brief.trim()) {
		parts.push(`<brief>\n${task.brief.trim()}\n</brief>`);
	} else {
		parts.push('No brief was given: judge the proposal against the research report.');
	}
	parts.push(`<research_report>\n${JSON.stringify(task.research, null, 2)}\n</research_report>`);
	parts.push(`<proposal>\n${JSON.stringify(task.proposal, null, 2)}\n</proposal>`);
	const checks = task.checks.length === 0 ? 'No findings: prices, service names, totals, currency and language passed.' : task.checks.map(formatFinding).join('\n');
	parts.push(`<automated_checks>\n${checks}\n</automated_checks>`);
	const name = task.clientName?.trim() ? task.clientName.trim() : task.proposal.client_name;
	const language = task.language ? `${LANGUAGE_NAMES[task.language]} (${task.language})` : `the language of the proposal (${task.proposal.language})`;
	parts.push(`Client name: ${name}\nToday: ${task.today}\nLanguage of the review: ${language}`);
	parts.push(`Review the proposal and deliver the review with ${REVIEW_FINAL_TOOL}.`);
	return parts.join('\n\n');
}

