import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRunError, runAgent, type AgentDefinition, type CreateParams, type LoopDeps, type Message } from '../src/loop.ts';
import { defineTool } from '../src/tools/types.ts';

type Content = Message['content'];

function reply(content: Content, stop: Message['stop_reason'] = 'end_turn'): Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'fake-model',
		content,
		stop_reason: stop,
		stop_sequence: null,
		stop_details: null,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: null },
	} as unknown as Message;
}

const text = (value: string): Content[number] => ({ type: 'text', text: value, citations: null }) as Content[number];
const call = (name: string, input: unknown, id = `tu_${name}`): Content[number] => ({ type: 'tool_use', id, name, input }) as Content[number];

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

const echo = defineTool({
	name: 'echo',
	description: 'Echoes text',
	schema: z.object({ text: z.string() }),
	async run(input) {
		if (input.text === 'boom') {
			throw new Error('boom happened');
		}
		return `echo:${input.text}`;
	},
});

const agent: AgentDefinition<{ answer: string }> = {
	name: 'test',
	system: 'You are a test agent.',
	tools: [echo],
	final: { name: 'submit_answer', description: 'Delivers the answer', schema: z.object({ answer: z.string() }) },
};

function toolResults(request: CreateParams): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
	const last = request.messages.at(-1);
	if (!last || typeof last.content === 'string') {
		return [];
	}
	return last.content.filter((block) => block.type === 'tool_result') as Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>;
}

describe('runAgent', () => {
	it('runs tools and stops when the final tool delivers a valid result', async () => {
		const deps = fakeDeps([reply([text('Let me check.'), call('echo', { text: 'hi' })], 'tool_use'), reply([call('submit_answer', { answer: 'hi back' })], 'tool_use')]);
		const result = await runAgent(deps, agent, 'Say hi', { maxSteps: 5 });

		expect(result.output).toEqual({ answer: 'hi back' });
		expect(result.model).toBe('fake-model');
		expect(result.steps).toHaveLength(2);
		expect(result.usage).toEqual({ requests: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 0 });
		expect(result.steps[0]?.toolCalls).toEqual([{ name: 'echo', input: { text: 'hi' }, isError: false, resultChars: 7, durationMs: expect.any(Number) }]);

		expect(deps.requests).toHaveLength(2);
		expect(deps.requests[0]?.tools?.map((tool) => ('name' in tool ? tool.name : ''))).toEqual(['echo', 'submit_answer']);
		expect(deps.requests[0]?.system).toBe('You are a test agent.');
		expect(toolResults(deps.requests[1]!)).toEqual([{ type: 'tool_result', tool_use_id: 'tu_echo', content: 'echo:hi' }]);
		expect(result.messages).toHaveLength(5);
	});

	it('rejects a final result that fails the schema and lets the model try again', async () => {
		const deps = fakeDeps([reply([call('submit_answer', { answer: 5 }, 'tu_1')], 'tool_use'), reply([call('submit_answer', { answer: 'ok' }, 'tu_2')], 'tool_use')]);
		const result = await runAgent(deps, agent, 'Answer', { maxSteps: 5 });

		expect(result.output).toEqual({ answer: 'ok' });
		const [feedback] = toolResults(deps.requests[1]!);
		expect(feedback?.is_error).toBe(true);
		expect(feedback?.content).toContain('does not match the expected format');
		expect(feedback?.content).toContain('answer');
	});

	it('reports tool errors and invalid tool inputs to the model', async () => {
		const deps = fakeDeps([
			reply([call('echo', { text: 'boom' }, 'tu_a'), call('echo', { text: 42 }, 'tu_b'), call('nope', {}, 'tu_c')], 'tool_use'),
			reply([call('submit_answer', { answer: 'done' })], 'tool_use'),
		]);
		const result = await runAgent(deps, agent, 'Go', { maxSteps: 5 });

		expect(result.output.answer).toBe('done');
		const results = toolResults(deps.requests[1]!);
		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({ tool_use_id: 'tu_a', is_error: true, content: 'Error: boom happened' });
		expect(results[1]?.is_error).toBe(true);
		expect(results[1]?.content).toContain('Invalid input for echo');
		expect(results[2]?.content).toContain('Unknown tool: nope');
	});

	it('reminds a model that answers in text, then gives up', async () => {
		const deps = fakeDeps([reply([text('Here is my answer.')]), reply([text('Again in text.')]), reply([text('Still text.')])]);
		await expect(runAgent(deps, agent, 'Go', { maxSteps: 5 })).rejects.toMatchObject({ name: 'AgentRunError', reason: 'no_result' });
		expect(deps.requests).toHaveLength(3);
		expect(deps.requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'Call the submit_answer tool now to deliver your result. Do not answer in text.' });
	});

	it('stops on a refusal, on a cut-off answer and on the step limit', async () => {
		const refusal = fakeDeps([reply([], 'refusal')]);
		await expect(runAgent(refusal, agent, 'Go', { maxSteps: 5 })).rejects.toMatchObject({ reason: 'refusal' });

		const cut = fakeDeps([reply([text('partial')], 'max_tokens')]);
		await expect(runAgent(cut, agent, 'Go', { maxSteps: 5 })).rejects.toMatchObject({ reason: 'max_tokens' });

		const endless = fakeDeps([reply([call('echo', { text: 'a' })], 'tool_use'), reply([call('echo', { text: 'b' })], 'tool_use')]);
		const error = await runAgent(endless, agent, 'Go', { maxSteps: 2 }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).reason).toBe('step_limit');
		expect((error as AgentRunError).steps).toHaveLength(2);
		expect((error as AgentRunError).usage.requests).toBe(2);
	});

	it('resumes after a pause_turn', async () => {
		const deps = fakeDeps([reply([text('working...')], 'pause_turn'), reply([call('submit_answer', { answer: 'resumed' })], 'tool_use')]);
		const result = await runAgent(deps, agent, 'Go', { maxSteps: 5 });
		expect(result.output.answer).toBe('resumed');
		expect(deps.requests[1]?.messages).toHaveLength(2);
	});
});
