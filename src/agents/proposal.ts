import { z } from 'zod';
import type { AgentDefinition } from '../loop.ts';
import type { AgentTool } from '../tools/types.ts';
import { LANGUAGE_NAMES, type ReportLanguage, type ResearchReport } from './research.ts';

export const ProposalSchema = z.object({
	client_name: z.string().describe('The business name, as the business writes it'),
	language: z.enum(['en', 'es']).describe('Language of the proposal'),
	title: z.string().describe('The client and the outcome, under twelve words'),
	summary: z.string().describe('Two to four sentences for the top of the proposal: their problem in their words, what we propose, what changes for them'),
	understanding: z.string().describe('What we understood about the business and its goals, from the research. One or two short paragraphs'),
	objectives: z.array(z.string()).describe('What success looks like, measurable where the research allows'),
	scope: z.array(
		z.object({
			name: z.string().describe("Short name of the work item, in the client's language"),
			service: z.string().describe('The agency service it maps to, named exactly as the knowledge names it'),
			description: z.string().describe('What it is and why they need it, two or three sentences'),
			deliverables: z.array(z.string()).describe('Concrete things the client receives'),
			price_min: z.number().describe('Lower end of the price range from the knowledge. 0 when the knowledge has no price for it'),
			price_max: z.number().describe('Upper end of the price range from the knowledge. 0 when the knowledge has no price for it'),
			price_note: z.string().describe('Empty when the range comes from the knowledge; otherwise why there is no price, for example "to quote after a call"'),
			priority: z.enum(['core', 'optional']).describe('core items make the total; optional items are offered separately'),
		}),
	),
	out_of_scope: z.array(z.string()).describe('What the proposal does not include, so there are no surprises'),
	timeline: z.array(
		z.object({
			phase: z.string(),
			duration: z.string().describe('In the language of the proposal, for example "week 1" or "semanas 2 y 3"'),
			work: z.string().describe('What the agency does in this phase'),
			needs_from_client: z.string().describe('What the client has to provide or decide; empty when nothing'),
		}),
	),
	investment: z.object({
		currency: z.string().describe('Three-letter code from the knowledge, for example AUD'),
		total_min: z.number().describe('Sum of the core items'),
		total_max: z.number().describe('Sum of the core items'),
		payment_terms: z.string().describe('From the knowledge'),
		market_comparison: z.string().describe('What the same work costs at market rates, when the knowledge says so; otherwise empty'),
		ongoing: z.string().describe('Monthly costs after delivery (maintenance, platforms), when they apply; otherwise empty'),
	}),
	next_steps: z.array(z.string()).describe('What happens if they say yes, in order'),
	internal: z.object({
		assumptions: z.array(z.string()).describe('What you assumed because the research or the brief did not say'),
		alerts: z.array(z.string()).describe('For the agency only: gaps in the research, risks, placeholders, anything to check before sending'),
		questions_for_client: z.array(z.string()).describe('What to ask before or when sending'),
	}),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export const PROPOSAL_FINAL_TOOL = 'submit_proposal';

export interface ProposalAgentOptions {
	/** The rendered agency knowledge (services, prices, tone, terms). */
	knowledge: string;
	tools: AgentTool[];
}

export function createProposalAgent(options: ProposalAgentOptions): AgentDefinition<Proposal> {
	return {
		name: 'proposal',
		system: buildSystemPrompt(options),
		tools: options.tools,
		final: {
			name: PROPOSAL_FINAL_TOOL,
			description: 'Delivers the finished proposal. Call it once, when the proposal is complete. It is the only way to deliver it.',
			schema: ProposalSchema,
		},
	};
}

function buildSystemPrompt(options: ProposalAgentOptions): string {
	return `You are the proposal agent of a digital agency. You receive a brief, the research report about the business and the agency's knowledge, and you write the proposal the agency sends to the client: what we understood, what we propose, how long it takes, what it costs and what happens next.

How to work
- Read the research first. The problems with the highest impact and the opportunities already mapped to services are the spine of the proposal. Address what the client asked for in the brief, add what the research shows they need, and leave the rest out or offer it as optional.
- Check the agency's notes with recall_client (earlier proposals, prices already discussed, who the contact is) and past_proposals (what similar work was quoted at), so prices and promises stay consistent.
- Save with remember_client what a colleague should know later: the amount quoted, what was promised, open questions.
- Deliver with ${PROPOSAL_FINAL_TOOL}. That call is the only deliverable: do not write the proposal as a text answer.

Rules
- Every fact comes from the brief, the research, the notes or the knowledge. Never invent results, metrics, past clients, team members or technologies. When the research marks something as unknown, do not state it as fact: put a question in internal.questions_for_client instead.
- Prices come from the knowledge: use its ranges and its service names, and do not go below them. When the knowledge has no price for something, set price_min and price_max to 0 and explain in price_note. The totals are the sum of the core items.
- Write in the client's language, in the agency's voice from the knowledge: direct, concrete, warm, no filler and no hype. Lead with the client's business, not with tools. Short sentences. The client reads everything except the internal section.
- Scope: two to five core items, sized to what the research found. Optional items go separately and do not count in the total.
- Timeline: realistic phases, each with what you need from the client.
- The internal section is for the agency: the assumptions you made, alerts (gaps, risks, placeholders) and the questions to ask before sending.

${options.knowledge}`;
}

export interface ProposalTask {
	brief: string;
	research: ResearchReport;
	clientName?: string;
	today: string;
	language?: ReportLanguage;
}

/** The user message: the brief, the research report as JSON and the few things that change per run. */
export function buildProposalMessage(task: ProposalTask): string {
	const parts: string[] = [];
	if (task.brief.trim()) {
		parts.push(`<brief>\n${task.brief.trim()}\n</brief>`);
	} else {
		parts.push('No brief was given: work from the research report.');
	}
	parts.push(`<research_report>\n${JSON.stringify(task.research, null, 2)}\n</research_report>`);
	const name = task.clientName?.trim() ? task.clientName.trim() : task.research.client_name;
	const language = task.language ? `${LANGUAGE_NAMES[task.language]} (${task.language})` : 'the language of the brief';
	parts.push(`Client name: ${name}\nToday: ${task.today}\nLanguage of the proposal: ${language}`);
	parts.push(`Write the proposal and deliver it with ${PROPOSAL_FINAL_TOOL}.`);
	return parts.join('\n\n');
}
