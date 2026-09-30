import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeProvider, loadConfig } from '../src/config.ts';

const cwd = path.resolve('/work');

describe('loadConfig', () => {
	it('defaults to Opus on the Claude API with data under ./data', () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }, cwd);
		expect(config.local).toBe(false);
		expect(config.model).toBe('claude-opus-5-5');
		expect(config.effort).toBe('medium');
		expect(config.apiKey).toBe('sk-test');
		expect(config.knowledgeDir).toBe(path.join(cwd, 'data', 'knowledge'));
		expect(config.clientsDir).toBe(path.join(cwd, 'data', 'clients'));
		expect(config.reportsDir).toBe(path.join(cwd, 'data', 'reports'));
		expect(config.runsDir).toBe(path.join(cwd, 'runs'));
		expect(config.maxSteps).toBe(20);
		expect(config.maxFetches).toBe(8);
		expect(describeProvider(config)).toBe('claude-opus-5-5 on the Claude API');
	});

	it('treats a non-Anthropic base URL as a local server that needs a model name', () => {
		expect(() => loadConfig({ ANTHROPIC_BASE_URL: 'http://localhost:11434' }, cwd)).toThrow(ConfigError);
		const config = loadConfig({ ANTHROPIC_BASE_URL: 'http://localhost:11434', BRAIN_MODEL: 'qwen3.6:35b-a3b' }, cwd);
		expect(config.local).toBe(true);
		expect(describeProvider(config)).toBe('qwen3.6:35b-a3b on a local server (http://localhost:11434)');

		const gateway = loadConfig({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, cwd);
		expect(gateway.local).toBe(false);
		expect(gateway.model).toBe('claude-opus-5-5');
	});

	it('resolves folders from BRAIN_DATA_DIR and explicit overrides', () => {
		const config = loadConfig({ BRAIN_DATA_DIR: 'vault', BRAIN_REPORTS_DIR: '/elsewhere/reports', BRAIN_RUNS_DIR: 'out' }, cwd);
		expect(config.knowledgeDir).toBe(path.join(cwd, 'vault', 'knowledge'));
		expect(config.reportsDir).toBe(path.resolve('/elsewhere/reports'));
		expect(config.runsDir).toBe(path.join(cwd, 'out'));
	});

	it('validates effort and numeric limits', () => {
		expect(() => loadConfig({ BRAIN_EFFORT: 'turbo' }, cwd)).toThrow(/BRAIN_EFFORT/);
		expect(() => loadConfig({ BRAIN_MAX_STEPS: '0' }, cwd)).toThrow(/BRAIN_MAX_STEPS/);
		expect(() => loadConfig({ BRAIN_MAX_FETCHES: 'lots' }, cwd)).toThrow(/BRAIN_MAX_FETCHES/);
		const config = loadConfig({ BRAIN_EFFORT: 'xhigh', BRAIN_MAX_STEPS: '3', BRAIN_TIMEOUT_MS: '5000' }, cwd);
		expect(config.effort).toBe('xhigh');
		expect(config.maxSteps).toBe(3);
		expect(config.requestTimeoutMs).toBe(5000);
	});
});
