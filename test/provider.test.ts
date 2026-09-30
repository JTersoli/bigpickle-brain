import { describe, expect, it } from 'vitest';
import type { RequestParts } from '../src/loop.ts';
import { buildRequest, FALLBACK_BETA, supportsAdaptiveThinking, supportsFallbacks } from '../src/provider.ts';

const parts: RequestParts = {
	system: 'system prompt',
	tools: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
	messages: [{ role: 'user', content: 'hi' }],
	maxTokens: 1000,
};

describe('buildRequest', () => {
	it('sends a plain request to a local server', () => {
		const params = buildRequest({ model: 'qwen3.6:35b-a3b', local: true, effort: 'high' }, parts);
		expect(params).toEqual({ model: 'qwen3.6:35b-a3b', max_tokens: 1000, system: 'system prompt', tools: parts.tools, messages: parts.messages });
		expect(params.tools?.[0]).not.toHaveProperty('strict');
	});

	it('caches, thinks, uses strict tools and falls back on the Claude API', () => {
		const params = buildRequest({ model: 'claude-opus-5-5', local: false, effort: 'high' }, parts);
		expect(params.system).toEqual([{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }]);
		expect(params.tools?.[0]).toMatchObject({ name: 'echo', strict: true });
		expect(params.thinking).toEqual({ type: 'adaptive' });
		expect(params.output_config).toEqual({ effort: 'high' });
		expect(params.cache_control).toEqual({ type: 'ephemeral' });
		expect(params.betas).toEqual([FALLBACK_BETA]);
		expect(params.fallbacks).toBe('default');
	});

	it('leaves thinking and fallbacks out for models that do not take them', () => {
		const params = buildRequest({ model: 'claude-haiku-4-5', local: false, effort: 'medium' }, parts);
		expect(params.thinking).toBeUndefined();
		expect(params.output_config).toBeUndefined();
		expect(params.betas).toBeUndefined();
		expect(params.fallbacks).toBeUndefined();
		expect(params.tools?.[0]).toMatchObject({ strict: true });
	});
});

describe('model capabilities', () => {
	it('knows which models take fallbacks and adaptive thinking', () => {
		expect(supportsFallbacks('claude-opus-5-5')).toBe(true);
		expect(supportsFallbacks('claude-sonnet-5-5')).toBe(true);
		expect(supportsFallbacks('claude-fable-5-1')).toBe(true);
		expect(supportsFallbacks('claude-sonnet-5')).toBe(false);
		expect(supportsFallbacks('claude-haiku-4-5')).toBe(false);
		expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true);
		expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
		expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
		expect(supportsAdaptiveThinking('qwen3.6:35b-a3b')).toBe(false);
	});
});
