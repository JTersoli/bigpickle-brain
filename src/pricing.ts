import type Anthropic from '@anthropic-ai/sdk';

/** USD per million tokens. Claude API list prices as of 2026-09-30; check platform.claude.com/pricing before trusting an estimate. */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export interface UsageTotals {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export function emptyUsage(): UsageTotals {
	return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(totals: UsageTotals, usage: Anthropic.Beta.BetaUsage): void {
	totals.requests += 1;
	totals.inputTokens += usage.input_tokens;
	totals.outputTokens += usage.output_tokens;
	totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
	totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

/** Estimated cost in USD, or null when the model has no known price (a local model costs nothing). */
export function estimateCost(model: string, usage: UsageTotals): number | null {
	const price = PRICES[model];
	if (!price) {
		return null;
	}
	const perToken = (rate: number) => rate / 1_000_000;
	return (
		usage.inputTokens * perToken(price.input) +
		usage.outputTokens * perToken(price.output) +
		usage.cacheReadTokens * perToken(price.cacheRead) +
		usage.cacheWriteTokens * perToken(price.cacheWrite)
	);
}

export function describeUsage(usage: UsageTotals, cost: number | null): string {
	const parts = [
		`${usage.requests} requests`,
		`${usage.inputTokens.toLocaleString('en-US')} tokens in`,
		`${usage.outputTokens.toLocaleString('en-US')} out`,
	];
	if (usage.cacheReadTokens > 0) {
		parts.push(`${usage.cacheReadTokens.toLocaleString('en-US')} read from cache`);
	}
	parts.push(cost === null ? 'cost: n/a (no price for this model)' : `cost: ~$${cost.toFixed(4)}`);
	return parts.join(', ');
}
