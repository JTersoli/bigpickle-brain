# bigpickle-brain

From a client brief to a researched, priced proposal, with AI agents that share a memory about your clients.

Built for [bigpickle](https://www.bigpickle.com.au), a digital agency in Sydney, and written so any small agency can use it: the code is generic, and the agency's own knowledge, client notes and reports live outside the repository, in plain Markdown you can open in Obsidian or any editor.

**Status:** v0.1. The first agent, **research**, works end to end. The proposal agent, the quality reviewer and the orchestrator come next (see the roadmap).

## What it does today

You give the research agent a brief about a prospect:

```bash
node src/cli.ts research "Gina's Bakery, artisan bakery in Bondi. Site: https://ginas.example.com. They sell through Instagram DMs and want online orders." --client "Gina's Bakery"
```

The agent then:

1. Checks the agency's notes about the business (`recall_client`).
2. Reads the business's website, page by page, and any competitor the brief names (`fetch_url`).
3. Saves the facts worth keeping to the client's note (`remember_client`).
4. Delivers a structured report (`submit_research`): summary, business profile, digital presence, problems with evidence, competitors, opportunities mapped to the agency's services and price ranges, questions for the client, sources and a confidence rating.

What you get back:

- A Markdown report, in the language of the brief, in your reports folder.
- The client's memory note updated with dated facts and a link to the report, so the next agent, or you, starts from there.
- A trace of the run (every step, tool call, token count and the estimated cost) in `runs/`.

```
Research agent: claude-opus-5-5 on the Claude API
step 1: recall_client {"name":"Gina's Bakery"} -> 61 chars (0.0 s)
step 2: fetch_url {"url":"https://ginas.example.com","offset":0} -> 6,412 chars (1.1 s)
step 3: fetch_url {"url":"https://ginas.example.com/menu","offset":0} -> 3,088 chars (0.7 s)
step 4: remember_client {"name":"Gina's Bakery","facts":[...]} -> 30 chars (0.0 s)
step 5: submit_research {...} -> 36 chars (0.0 s)

Report:  .../reports/2026-09-30 Research Gina's Bakery.md
Memory:  .../clients/gina-s-bakery.md
Trace:   runs/2026-09-30-154210-gina-s-bakery
5 steps, 2 pages fetched, 48 s, 5 requests, 31,204 tokens in, 4,120 out, 24,900 read from cache, cost: ~$0.13
```

## Why

Every proposal starts the same way: an hour of re-discovering the client. What do they sell, what is their website like, who are they up against, what would actually move the needle, what does that cost. That work is repetitive, it is where the agency's knowledge lives, and it is the part that gets skipped when the week is busy.

The goal is a system of three agents, coordinated by an orchestrator, that turns a brief into a proposal in minutes:

- **Research**: the business and its competition. Done.
- **Proposal and quote**: with the agency's services, the price history and the tone. Next.
- **Quality review**: checks the proposal against the research and the rules before a person sees it.

They share one memory about clients, and everything they produce is a note a person can read, edit and correct.

## How it works

```
brief ──▶ research agent ──▶ report.md
              │  ▲                 │
       tools  ▼  │ results         ▼
   fetch_url · recall_client · remember_client        client memory (append-only notes)
```

- **The agent loop** ([src/loop.ts](src/loop.ts)) is written by hand on the Anthropic Messages API: send the system prompt, the tools and the conversation; run the tools the model calls; feed the results back; repeat until the model calls the *final tool* with a result that matches the schema. The final tool is how an agent delivers its output: a strict JSON schema, validated with Zod, so a report always has the same shape. Answers in text get a reminder; refusals, cut-off answers and step limits stop the run with a saved trace.
- **Tools** live in [src/tools/](src/tools/). Each one is a Zod schema plus a function. The schema becomes the tool definition the API receives, and every input is validated before it runs, on any model.
- **Knowledge** ([src/tools/knowledge.ts](src/tools/knowledge.ts)): every Markdown note in the knowledge folder goes into the system prompt, in a fixed order, so it is cached between requests. A note with `private: true` in its frontmatter is never sent.
- **Memory** ([src/tools/memory.ts](src/tools/memory.ts)): one note per client, append-only. Agents add dated lines (`- 2026-09-30 (research): ...`); the harness adds the report summary and link after every run, so memory does not depend on the model remembering to write. People edit the notes freely.
- **Provider** ([src/provider.ts](src/provider.ts)): one code path for the Claude API and for any server that speaks the Anthropic Messages API, such as Ollama. On Claude: cached system prompt, cached conversation, strict tools, adaptive thinking with a configurable effort, and server-side fallbacks for safety-classifier refusals. On a local server: the plain request.

## Setup

Requirements: Node 24 or newer (the code runs as TypeScript, no build step).

```bash
npm install
cp .env.example .env
```

Then pick a model in `.env`:

**Claude API** (best quality, paid per token; keys from [console.anthropic.com](https://console.anthropic.com)):

```
ANTHROPIC_API_KEY=sk-ant-...
BRAIN_MODEL=claude-opus-5-5
BRAIN_EFFORT=medium
```

**Local and free** with [Ollama](https://ollama.com) 0.34 or newer, which serves the Anthropic-compatible API on port 11434. Use a model with tool support; the run needs a context window of about 32k tokens (Ollama's current default):

```
ANTHROPIC_BASE_URL=http://localhost:11434
BRAIN_MODEL=qwen3.6:35b-a3b
```

Local models are slower and less thorough than Claude, but they cost nothing and nothing leaves your machine. The same code runs on both, so develop locally and switch to Claude when quality matters.

Finally, point the data folders at your notes, or use the defaults (`data/knowledge`, `data/clients`, `data/reports`, all ignored by git):

```
BRAIN_KNOWLEDGE_DIR=C:\path\to\vault\Brain\Knowledge
BRAIN_CLIENTS_DIR=C:\path\to\vault\Brain\Clients
BRAIN_REPORTS_DIR=C:\path\to\vault\Brain\Reports
```

Put at least one note in the knowledge folder: who you are, who you work with, what you sell and for how much. [data.example/knowledge/agency.md](data.example/knowledge/agency.md) is a template.

## Usage

```bash
# Brief on the command line
node src/cli.ts research "<brief>" --client "<business name>"

# Brief from a file
node src/cli.ts research --file brief.md --client "<business name>"

# One-off overrides
node src/cli.ts research "<brief>" --model claude-sonnet-5-5 --effort high --max-steps 30
```

`--client` is optional but recommended: it names the memory note and the report file. Without it the agent takes the name from the brief.

## Output

**The report** is a note with frontmatter (`type`, `client`, `website`, `date`, `model`, `confidence`) and these sections: summary, the business, digital presence (table), problems found (with evidence and impact), competitors, opportunities for the agency (service, why, price range, priority), questions for the client, sources, confidence, the brief, and the run (model, steps, pages, tokens, cost). Headings follow the report's language (English or Spanish).

**The client note** looks like this:

```markdown
---
type: client
name: "Gina's Bakery"
created: 2026-09-30
updated: 2026-09-30
---

# Gina's Bakery

## Notes

- 2026-09-30 (agent): Sells sourdough, pastries and coffee from one shop in Bondi.
- 2026-09-30 (research): Website: https://ginas.example.com
- 2026-09-30 (research): Research report: [[2026-09-30 Research Gina's Bakery]]
```

**The trace** (`runs/<date>-<time>-<client>/`) has `trace.jsonl` (one line per step: stop reason, tokens, tool calls with timings), `messages.json` (the full conversation) and `summary.json` (usage, cost, report). Failed runs save it too.

## Cost and observability

On Claude, the system prompt (rules plus knowledge) is cached and reused across the steps of a run and across runs within five minutes, and the conversation tail is cached automatically, so most input tokens are billed at the cache-read rate. Every run prints and saves the token counts and an estimate in USD from the list prices in [src/pricing.ts](src/pricing.ts). Adaptive thinking is on, with `BRAIN_EFFORT` (default `medium`) controlling how much the model thinks. `BRAIN_MAX_STEPS` and `BRAIN_MAX_FETCHES` cap a run.

## Security

The agent reads the open web, so the harness is built around one idea: **the model decides what to look at; the code decides what happens.**

- Fetched pages are untrusted. They are wrapped in a `<fetched_page>` block with a warning, the model is told to treat them as data, and nothing a page says can make the code do anything: tool inputs are validated, the memory is append-only and confined to its folder, report file names are sanitised, and the only way out of a run is the final tool's schema.
- `fetch_url` only fetches public `http(s)` URLs. Localhost, private and link-local ranges (IPv4 and IPv6), URLs with credentials and non-web schemes are refused, on every redirect hop. Downloads are capped in size and time, and only HTML and text are read.
- Tool schemas are strict on Claude (`strict: true`), and every input is checked with Zod before a tool runs, on any model.
- No client data in the repository: `.env`, `data/` and `runs/` are ignored. Knowledge notes marked `private: true` are never sent.
- Known limits: DNS rebinding is not covered (the check is on the hostname, not the resolved address); pages that need JavaScript to render come back empty; there is no web search yet.

## Roadmap

1. **Research agent** with tools and memory, end to end. Done (v0.1).
2. **Proposal and quote agent** and the orchestrator that runs research then proposal.
3. **Quality review agent**, and the shared memory read and written by all three.
4. **Evals**: a set of briefs with expected findings, and prompt-injection test pages.
5. **Production**: deploy, a minimal interface, time and cost metrics per run.
6. Write-up and a public example.

## Development

```bash
npm run check       # typecheck + lint + tests
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

The tests cover the HTML reader, the URL rules and the fetch tool, the memory store and its tools, the knowledge loader, the provider profiles, the report renderer, the agent loop (against a fake model) and a full research run (against a fake model, with real files).

## License

MIT
