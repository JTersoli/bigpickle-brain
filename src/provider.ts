import Anthropic from '@anthropic-ai/sdk';
import type { BrainConfig } from './config.ts';
import type { CreateParams, LoopDeps, RequestParts } from './loop.ts';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models whose safety classifiers can decline a request and re-run it on a fallback model, server side. */
export function supportsFallbacks(model: string): boolean {
	return /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(model);
}

/** Models that take adaptive thinking and an effort level (Haiku 4.5 and older models do not). */
export function supportsAdaptiveThinking(model: string): boolean {
	return /^claude-(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos-5)/.test(model);
}

type ProviderConfig = Pick<BrainConfig, 'model' | 'local' | 'effort'>;

/**
 * Turns the loop's request parts into API parameters. On the Claude API the system prompt is cached,
 * tools are strict, thinking is adaptive and refusals fall back server side. A local server gets the
 * plain request, because it ignores or rejects those fields.
 */
export function buildRequest(config: ProviderConfig, parts: RequestParts): CreateParams {
	if (config.local) {
		return {
			model: config.model,
			max_tokens: parts.maxTokens,
			system: parts.system,
			tools: parts.tools,
			messages: parts.messages,
		};
	}

	const params: CreateParams = {
		model: config.model,
		max_tokens: parts.maxTokens,
		system: [{ type: 'text', text: parts.system, cache_control: { type: 'ephemeral' } }],
		tools: parts.tools.map((tool) => ({ ...tool, strict: true })),
		messages: parts.messages,
		cache_control: { type: 'ephemeral' },
	};
	if (supportsAdaptiveThinking(config.model)) {
		params.thinking = { type: 'adaptive' };
		params.output_config = { effort: config.effort };
	}
	if (supportsFallbacks(config.model)) {
		params.betas = [FALLBACK_BETA];
		params.fallbacks = 'default';
	}
	return params;
}

export function createClient(config: Pick<BrainConfig, 'apiKey' | 'baseURL' | 'local' | 'requestTimeoutMs'>): Anthropic {
	return new Anthropic({
		apiKey: config.apiKey ?? (config.local ? 'local' : undefined),
		baseURL: config.baseURL,
		timeout: config.requestTimeoutMs,
		maxRetries: 2,
	});
}

export function createLoopDeps(config: BrainConfig): LoopDeps {
	const client = createClient(config);
	return {
		createMessage: (params) => client.beta.messages.create(params),
		buildRequest: (parts) => buildRequest(config, parts),
	};
}

/** A message a person can act on, for every error a request can raise. */
export function describeError(error: unknown): string {
	if (error instanceof Anthropic.AuthenticationError) {
		return 'The API key was rejected. Check ANTHROPIC_API_KEY.';
	}
	if (error instanceof Anthropic.PermissionDeniedError) {
		return 'This API key is not allowed to use this model.';
	}
	if (error instanceof Anthropic.NotFoundError) {
		return `The model was not found (${error.message}). Check BRAIN_MODEL.`;
	}
	if (error instanceof Anthropic.RateLimitError) {
		return 'The API is rate limiting this key. Wait a minute and try again.';
	}
	if (error instanceof Anthropic.BadRequestError) {
		return `The API rejected the request: ${error.message}`;
	}
	if (error instanceof Anthropic.APIConnectionTimeoutError) {
		return 'The request timed out. A local model may need more time: raise BRAIN_TIMEOUT_MS.';
	}
	if (error instanceof Anthropic.APIConnectionError) {
		return 'Could not reach the model server. Check your connection, or that the local server is running.';
	}
	if (error instanceof Anthropic.APIError) {
		return `API error ${error.status ?? ''}: ${error.message}`.replace('  ', ' ');
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
