import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { addUsage, emptyUsage, type UsageTotals } from './pricing.ts';
import { formatIssues, toApiTool, type AgentTool, type ApiTool } from './tools/types.ts';

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** What every request is made of; the provider turns it into API parameters. */
export interface RequestParts {
	system: string;
	tools: ApiTool[];
	messages: MessageParam[];
	maxTokens: number;
}

export interface LoopDeps {
	createMessage(params: CreateParams): Promise<Message>;
	buildRequest(parts: RequestParts): CreateParams;
}

/** The tool the agent calls to deliver its result. Its input is the agent's output. */
export interface FinalTool<Output> {
	name: string;
	description: string;
	schema: z.ZodType<Output>;
}

export interface AgentDefinition<Output> {
	name: string;
	system: string;
	tools: AgentTool[];
	final: FinalTool<Output>;
	maxTokens?: number;
}

export interface ToolCallRecord {
	name: string;
	input: unknown;
	isError: boolean;
	resultChars: number;
	durationMs: number;
}

export interface StepRecord {
	step: number;
	startedAt: string;
	durationMs: number;
	stopReason: string | null;
	text: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	toolCalls: ToolCallRecord[];
}

export interface RunResult<Output> {
	output: Output;
	model: string;
	steps: StepRecord[];
	usage: UsageTotals;
	messages: MessageParam[];
	durationMs: number;
}

export interface RunOptions {
	maxSteps: number;
	log?: (line: string) => void;
	now?: () => Date;
}

export type RunFailure = 'refusal' | 'max_tokens' | 'context_window' | 'no_result' | 'step_limit';

export class AgentRunError extends Error {
	readonly reason: RunFailure;
	readonly steps: StepRecord[];
	readonly messages: MessageParam[];
	readonly usage: UsageTotals;

	constructor(reason: RunFailure, message: string, state: { steps: StepRecord[]; messages: MessageParam[]; usage: UsageTotals }) {
		super(message);
		this.name = 'AgentRunError';
		this.reason = reason;
		this.steps = state.steps;
		this.messages = state.messages;
		this.usage = state.usage;
	}
}

const MAX_NUDGES = 2;

/**
 * The agent loop: ask the model, run the tools it calls, feed the results back, until it calls the
 * final tool with a result that matches the schema. Every tool input is validated before it runs.
 */
export async function runAgent<Output>(deps: LoopDeps, agent: AgentDefinition<Output>, userMessage: string, options: RunOptions): Promise<RunResult<Output>> {
	const log = options.log ?? (() => undefined);
	const now = options.now ?? (() => new Date());
	const startedAt = now();
	const messages: MessageParam[] = [{ role: 'user', content: userMessage }];
	const toolsByName = new Map(agent.tools.map((tool) => [tool.name, tool]));
	const apiTools: ApiTool[] = [...agent.tools.map(toApiTool), toApiTool(agent.final)];
	const maxTokens = agent.maxTokens ?? 16_000;
	const usage = emptyUsage();
	const steps: StepRecord[] = [];
	const state = { steps, messages, usage };

	let output: Output | undefined;
	let delivered = false;
	let nudges = 0;
	let model = '';

	for (let step = 1; step <= options.maxSteps; step++) {
		const stepStart = now();
		const response = await deps.createMessage(deps.buildRequest({ system: agent.system, tools: apiTools, messages, maxTokens }));
		model = response.model;
		addUsage(usage, response.usage);

		const record: StepRecord = {
			step,
			startedAt: stepStart.toISOString(),
			durationMs: now().getTime() - stepStart.getTime(),
			stopReason: response.stop_reason,
			text: response.content
				.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('\n'),
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
			toolCalls: [],
		};
		steps.push(record);

		if (response.stop_reason === 'refusal') {
			const details = response.stop_details;
			const why = details ? ` (${details.category ?? 'no category'}: ${details.explanation ?? 'no explanation'})` : '';
			throw new AgentRunError('refusal', `The model declined to continue${why}.`, state);
		}
		if (response.stop_reason === 'max_tokens') {
			throw new AgentRunError('max_tokens', `The answer at step ${step} was cut off at ${maxTokens} tokens.`, state);
		}
		if (response.stop_reason === 'model_context_window_exceeded') {
			throw new AgentRunError('context_window', `The conversation no longer fits the model's context window (step ${step}).`, state);
		}

		messages.push({ role: 'assistant', content: response.content });

		if (response.stop_reason === 'pause_turn') {
			log(`step ${step}: paused by the server, resuming`);
			continue;
		}

		const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
		if (toolUses.length === 0) {
			if (nudges >= MAX_NUDGES) {
				throw new AgentRunError('no_result', `The model answered in text instead of calling ${agent.final.name}, even after ${MAX_NUDGES} reminders.`, state);
			}
			nudges += 1;
			log(`step ${step}: no tool call, reminding the model to use ${agent.final.name}`);
			messages.push({ role: 'user', content: `Call the ${agent.final.name} tool now to deliver your result. Do not answer in text.` });
			continue;
		}

		const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
		for (const use of toolUses) {
			const callStart = now();
			let content: string;
			let isError = false;

			if (use.name === agent.final.name) {
				const parsed = agent.final.schema.safeParse(use.input);
				if (parsed.success) {
					output = parsed.data;
					delivered = true;
					content = 'Result received. The task is complete.';
				} else {
					isError = true;
					content = `The result does not match the expected format. Fix these issues and call ${agent.final.name} again:\n${formatIssues(parsed.error)}`;
				}
			} else {
				const tool = toolsByName.get(use.name);
				if (!tool) {
					isError = true;
					content = `Unknown tool: ${use.name}. Available tools: ${[...toolsByName.keys(), agent.final.name].join(', ')}.`;
				} else {
					const parsed = tool.schema.safeParse(use.input);
					if (!parsed.success) {
						isError = true;
						content = `Invalid input for ${use.name}:\n${formatIssues(parsed.error)}`;
					} else {
						try {
							content = await tool.run(parsed.data, { log });
						} catch (error) {
							isError = true;
							content = `Error: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
				}
			}

			const durationMs = now().getTime() - callStart.getTime();
			record.toolCalls.push({ name: use.name, input: use.input, isError, resultChars: content.length, durationMs });
			const outcome = isError ? `error: ${firstLine(content)}` : `${content.length.toLocaleString('en-US')} chars`;
			log(`step ${step}: ${use.name} ${summarizeInput(use.input)} -> ${outcome} (${(durationMs / 1000).toFixed(1)} s)`);
			results.push({ type: 'tool_result', tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
		}
		messages.push({ role: 'user', content: results });

		if (delivered) {
			break;
		}
	}

	if (!delivered || output === undefined) {
		throw new AgentRunError('step_limit', `The agent did not deliver a result within ${options.maxSteps} steps.`, state);
	}

	return { output, model, steps, usage, messages, durationMs: now().getTime() - startedAt.getTime() };
}

function summarizeInput(input: unknown): string {
	const text = JSON.stringify(input) ?? '';
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function firstLine(text: string): string {
	const line = text.split('\n')[0] ?? '';
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
