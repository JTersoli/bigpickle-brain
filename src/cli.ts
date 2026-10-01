import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { ResearchReportSchema, type ReportLanguage, type ResearchReport } from './agents/research.ts';
import { ConfigError, describeProvider, loadConfig, type BrainConfig } from './config.ts';
import { AgentRunError } from './loop.ts';
import { runPipeline } from './pipeline.ts';
import { describeUsage } from './pricing.ts';
import { formatMoney } from './proposalReport.ts';
import { runProposal } from './propose.ts';
import { describeError } from './provider.ts';
import { runResearch } from './run.ts';

const USAGE = `bigpickle-brain: from a client brief to a researched, priced proposal.

Usage:
  node src/cli.ts pipeline "<brief>" [options]        research, then the proposal
  node src/cli.ts research "<brief>" [options]        research only
  node src/cli.ts propose --research <summary.json>   proposal from a saved research run
  node src/cli.ts <command> --file brief.md [options]

Options:
  -c, --client <name>       The business name (defaults to what the brief says)
  -f, --file <path>         Read the brief from a file
  -l, --language <es|en>    Language of the notes (defaults to the brief's language)
  -r, --research <path>     propose only: the summary.json of a research run (in runs/)
  -m, --model <id>          Model to use (overrides BRAIN_MODEL)
      --effort <level>      low | medium | high | xhigh | max (Claude models only)
      --max-steps <n>       Steps an agent may take (default 20)
  -q, --quiet               Only print the result
  -h, --help                This help

Configuration comes from the environment or a .env file in the current folder. See .env.example.`;

type Command = 'pipeline' | 'research' | 'propose';

async function main(argv: string[]): Promise<number> {
	loadDotEnv();

	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			file: { type: 'string', short: 'f' },
			client: { type: 'string', short: 'c' },
			language: { type: 'string', short: 'l' },
			research: { type: 'string', short: 'r' },
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
	if (!isCommand(command)) {
		console.error(`Unknown command: ${command}\n\n${USAGE}`);
		return 1;
	}
	if (values.language !== undefined && values.language !== 'es' && values.language !== 'en') {
		console.error(`--language must be "es" or "en" (got "${values.language}").`);
		return 1;
	}
	const language = values.language as ReportLanguage | undefined;

	let brief = rest.join(' ').trim();
	if (values.file) {
		brief = (await readFile(path.resolve(values.file), 'utf8')).trim();
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

	if (command === 'propose') {
		if (!values.research) {
			console.error(`propose needs --research <summary.json> from a research run.\n\n${USAGE}`);
			return 1;
		}
		const saved = await loadSavedResearch(values.research);
		if (!saved) {
			return 1;
		}
		printHeader('Proposal agent', config);
		const outcome = await runProposal({ brief: brief || saved.brief, research: saved.report, researchNoteName: saved.noteName, clientName: values.client, language, config, log });
		console.error('');
		printProposal(outcome.proposalPath, outcome.memoryPath, outcome.runDir, outcome.totals, outcome.proposal.investment.currency, outcome.proposal.language);
		console.log(`${outcome.result.steps.length} steps, ${(outcome.result.durationMs / 1000).toFixed(0)} s, ${describeUsage(outcome.result.usage, outcome.cost)}`);
		return 0;
	}

	if (!brief) {
		console.error(`Give the brief as an argument or with --file.\n\n${USAGE}`);
		return 1;
	}

	if (command === 'research') {
		printHeader('Research agent', config);
		const outcome = await runResearch({ brief, clientName: values.client, language, config, log });
		console.error('');
		console.log(`Report:  ${outcome.reportPath}`);
		console.log(`Memory:  ${outcome.memoryPath}`);
		console.log(`Trace:   ${outcome.runDir}`);
		console.log(`${outcome.result.steps.length} steps, ${outcome.fetches} pages fetched, ${(outcome.result.durationMs / 1000).toFixed(0)} s, ${describeUsage(outcome.result.usage, outcome.cost)}`);
		return 0;
	}

	printHeader('Pipeline (research, then proposal)', config);
	const outcome = await runPipeline({ brief, clientName: values.client, language, config, log });
	console.error('');
	console.log(`Report:   ${outcome.research.reportPath}`);
	printProposal(outcome.proposal.proposalPath, outcome.proposal.memoryPath, outcome.runDir, outcome.proposal.totals, outcome.proposal.proposal.investment.currency, outcome.proposal.proposal.language);
	console.log(
		`${outcome.research.result.steps.length + outcome.proposal.result.steps.length} steps, ${outcome.research.fetches} pages fetched, ${(outcome.durationMs / 1000).toFixed(0)} s, ${describeUsage(outcome.usage, outcome.cost)}`,
	);
	return 0;
}

function isCommand(value: string): value is Command {
	return value === 'pipeline' || value === 'research' || value === 'propose';
}

function printHeader(title: string, config: BrainConfig): void {
	console.error(`${title}: ${describeProvider(config)}`);
	console.error(`Knowledge: ${config.knowledgeDir}`);
	console.error(`Clients:   ${config.clientsDir}`);
	console.error(`Reports:   ${config.reportsDir}`);
	console.error(`Proposals: ${config.proposalsDir}`);
	console.error('');
}

function printProposal(proposalPath: string, memoryPath: string, runDir: string, totals: { min: number; max: number }, currency: string, language: ReportLanguage): void {
	console.log(`Proposal: ${proposalPath}`);
	console.log(`Memory:   ${memoryPath}`);
	console.log(`Trace:    ${runDir}`);
	console.log(`Total:    ${formatMoney(totals.min, currency || 'AUD', language)} – ${formatMoney(totals.max, currency || 'AUD', language)}`);
}

interface SavedResearch {
	report: ResearchReport;
	brief: string;
	noteName?: string;
}

/** Reads a research run's summary.json (or a bare report JSON) and validates the report. */
async function loadSavedResearch(file: string): Promise<SavedResearch | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path.resolve(file), 'utf8'));
	} catch (error) {
		console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	const record = (raw ?? {}) as Record<string, unknown>;
	const candidate = 'report' in record ? record.report : raw;
	const parsed = ResearchReportSchema.safeParse(candidate);
	if (!parsed.success) {
		console.error(`${file} does not contain a research report: ${parsed.error.issues[0]?.message ?? 'unexpected format'}`);
		return null;
	}
	const reportPath = typeof record.reportPath === 'string' ? record.reportPath : undefined;
	return {
		report: parsed.data,
		brief: typeof record.brief === 'string' ? record.brief : '',
		noteName: reportPath ? path.basename(reportPath, '.md') : undefined,
	};
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
