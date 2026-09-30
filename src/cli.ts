import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { ConfigError, describeProvider, loadConfig } from './config.ts';
import { AgentRunError } from './loop.ts';
import { describeUsage } from './pricing.ts';
import { describeError } from './provider.ts';
import { runResearch } from './run.ts';

const USAGE = `bigpickle-brain: from a client brief to a researched proposal.

Usage:
  node src/cli.ts research "<brief>" [options]
  node src/cli.ts research --file brief.md [options]

Options:
  -c, --client <name>   The business name (defaults to what the brief says)
  -f, --file <path>     Read the brief from a file
  -l, --language <es|en>  Language of the report (defaults to the brief's language)
  -m, --model <id>      Model to use (overrides BRAIN_MODEL)
      --effort <level>  low | medium | high | xhigh | max (Claude models only)
      --max-steps <n>   Steps the agent may take (default 20)
  -q, --quiet           Only print the result
  -h, --help            This help

Configuration comes from the environment or a .env file in the current folder. See .env.example.`;

async function main(argv: string[]): Promise<number> {
	loadDotEnv();

	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			file: { type: 'string', short: 'f' },
			client: { type: 'string', short: 'c' },
			language: { type: 'string', short: 'l' },
			model: { type: 'string', short: 'm' },
			effort: { type: 'string' },
			'max-steps': { type: 'string' },
			quiet: { type: 'boolean', short: 'q' },
			help: { type: 'boolean', short: 'h' },
		},
	});

	const [command, ...rest] = positionals;
	if (values.help || !command) {
		console.log(USAGE);
		return values.help ? 0 : 1;
	}
	if (command !== 'research') {
		console.error(`Unknown command: ${command}\n\n${USAGE}`);
		return 1;
	}

	let brief = rest.join(' ').trim();
	if (values.file) {
		brief = (await readFile(path.resolve(values.file), 'utf8')).trim();
	}
	if (!brief) {
		console.error(`Give the brief as an argument or with --file.\n\n${USAGE}`);
		return 1;
	}

	if (values.language !== undefined && values.language !== 'es' && values.language !== 'en') {
		console.error(`--language must be "es" or "en" (got "${values.language}").`);
		return 1;
	}

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (values.model) {
		env.BRAIN_MODEL = values.model;
	}
	if (values.effort) {
		env.BRAIN_EFFORT = values.effort;
	}
	if (values['max-steps']) {
		env.BRAIN_MAX_STEPS = values['max-steps'];
	}
	const config = loadConfig(env);
	const log = values.quiet ? () => undefined : (line: string) => console.error(line);

	console.error(`Research agent: ${describeProvider(config)}`);
	console.error(`Knowledge: ${config.knowledgeDir}`);
	console.error(`Clients:   ${config.clientsDir}`);
	console.error(`Reports:   ${config.reportsDir}`);
	console.error('');

	const outcome = await runResearch({ brief, clientName: values.client, language: values.language, config, log });

	console.error('');
	console.log(`Report:  ${outcome.reportPath}`);
	console.log(`Memory:  ${outcome.memoryPath}`);
	console.log(`Trace:   ${outcome.runDir}`);
	console.log(
		`${outcome.result.steps.length} steps, ${outcome.fetches} pages fetched, ${(outcome.result.durationMs / 1000).toFixed(0)} s, ${describeUsage(outcome.result.usage, outcome.cost)}`,
	);
	return 0;
}

/** The .env in the current folder is this tool's configuration file, so its values win over the environment. */
function loadDotEnv(): void {
	const file = path.resolve('.env');
	if (!existsSync(file)) {
		return;
	}
	try {
		Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
	} catch {
		// A malformed .env is not fatal: the environment may already be set.
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		if (error instanceof ConfigError) {
			console.error(`Configuration error: ${error.message}`);
		} else if (error instanceof AgentRunError) {
			console.error(`The run failed (${error.reason}): ${error.message}`);
			console.error('The trace was saved in the runs folder.');
		} else {
			console.error(`Error: ${describeError(error)}`);
		}
		process.exitCode = 1;
	},
);
