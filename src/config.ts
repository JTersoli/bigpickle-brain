import path from 'node:path';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The default when nothing else is configured: the current Opus. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface BrainConfig {
	/** Where the Anthropic SDK sends requests. Undefined means the Claude API. */
	baseURL: string | undefined;
	apiKey: string | undefined;
	/** True when the base URL points at a local Anthropic-compatible server, such as Ollama. */
	local: boolean;
	model: string;
	effort: Effort;
	maxSteps: number;
	maxFetches: number;
	maxToolResultChars: number;
	requestTimeoutMs: number;
	knowledgeDir: string;
	clientsDir: string;
	reportsDir: string;
	proposalsDir: string;
	runsDir: string;
}

export class ConfigError extends Error {}

/** Reads the configuration from environment variables. Relative paths are resolved against `cwd`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): BrainConfig {
	const baseURL = clean(env.ANTHROPIC_BASE_URL);
	const local = baseURL !== undefined && !/\.anthropic\.com/i.test(baseURL);
	const model = clean(env.BRAIN_MODEL) ?? (local ? undefined : DEFAULT_MODEL);
	if (!model) {
		throw new ConfigError('BRAIN_MODEL is not set. With a local server, name the model to use, for example BRAIN_MODEL=qwen3.6:35b-a3b.');
	}

	const effort = clean(env.BRAIN_EFFORT) ?? 'medium';
	if (!isEffort(effort)) {
		throw new ConfigError(`BRAIN_EFFORT must be one of ${EFFORTS.join(', ')} (got "${effort}").`);
	}

	const dataDir = path.resolve(cwd, clean(env.BRAIN_DATA_DIR) ?? 'data');
	const resolve = (value: string | undefined, fallback: string) => path.resolve(cwd, clean(value) ?? fallback);

	return {
		baseURL,
		apiKey: clean(env.ANTHROPIC_API_KEY),
		local,
		model,
		effort,
		maxSteps: integer(env.BRAIN_MAX_STEPS, 'BRAIN_MAX_STEPS', 20),
		maxFetches: integer(env.BRAIN_MAX_FETCHES, 'BRAIN_MAX_FETCHES', 8),
		maxToolResultChars: integer(env.BRAIN_MAX_TOOL_RESULT_CHARS, 'BRAIN_MAX_TOOL_RESULT_CHARS', 12_000),
		requestTimeoutMs: integer(env.BRAIN_TIMEOUT_MS, 'BRAIN_TIMEOUT_MS', 10 * 60 * 1000),
		knowledgeDir: resolve(env.BRAIN_KNOWLEDGE_DIR, path.join(dataDir, 'knowledge')),
		clientsDir: resolve(env.BRAIN_CLIENTS_DIR, path.join(dataDir, 'clients')),
		reportsDir: resolve(env.BRAIN_REPORTS_DIR, path.join(dataDir, 'reports')),
		proposalsDir: resolve(env.BRAIN_PROPOSALS_DIR, path.join(dataDir, 'proposals')),
		runsDir: resolve(env.BRAIN_RUNS_DIR, 'runs'),
	};
}

export function describeProvider(config: Pick<BrainConfig, 'baseURL' | 'local' | 'model'>): string {
	if (config.local) {
		return `${config.model} on a local server (${config.baseURL})`;
	}
	return `${config.model} on the Claude API`;
}

function clean(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isEffort(value: string): value is Effort {
	return (EFFORTS as readonly string[]).includes(value);
}

function integer(value: string | undefined, name: string, fallback: number): number {
	const text = clean(value);
	if (text === undefined) {
		return fallback;
	}
	const parsed = Number(text);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new ConfigError(`${name} must be a positive integer (got "${text}").`);
	}
	return parsed;
}
