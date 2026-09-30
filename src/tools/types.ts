import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface ToolContext {
	log: (line: string) => void;
}

/** A tool the agent can call: a Zod schema for its input and a function that returns text for the model. */
export interface AgentTool<Schema extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	schema: Schema;
	run(input: z.output<Schema>, context: ToolContext): Promise<string>;
}

/** Identity function that keeps the schema type for `run`. */
export function defineTool<Schema extends z.ZodType>(tool: AgentTool<Schema>): AgentTool<Schema> {
	return tool;
}

export type ApiTool = Anthropic.Beta.BetaTool;

/** The tool definition the API receives. */
export function toApiTool(tool: Pick<AgentTool, 'name' | 'description' | 'schema'>): ApiTool {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: toInputSchema(tool.schema),
	};
}

/** Zod's JSON Schema, trimmed to what strict tool use accepts. */
export function toInputSchema(schema: z.ZodType): ApiTool['input_schema'] {
	const json = cleanSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
	if (json.type !== 'object') {
		throw new Error('A tool input schema must be an object');
	}
	return json as ApiTool['input_schema'];
}

function cleanSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cleanSchema);
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === '$schema') {
			continue;
		}
		if ((key === 'maximum' && entry === Number.MAX_SAFE_INTEGER) || (key === 'minimum' && entry === Number.MIN_SAFE_INTEGER)) {
			continue;
		}
		out[key] = cleanSchema(entry);
	}
	return out;
}

export function formatIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `- ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('\n');
}
