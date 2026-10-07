# bigpickle-brain

From a client brief to a researched, priced and reviewed proposal, with AI agents that share a memory about your clients.

Built for [bigpickle](https://www.bigpickle.com.au), a digital agency in Sydney, and written so any small agency can use it: the code is generic, and the agency's own knowledge, client notes, reports, proposals and reviews live outside the repository, in plain Markdown you can open in Obsidian or any editor.

**Status:** v0.4. Three agents work end to end, **research**, **proposal** and **quality review**, a pipeline runs them in order, sending the proposal back for a rewrite when the reviewer does not approve, and a set of **evals** measures what the review catches and how the research agent holds up against prompt injection. Production comes next (see the roadmap).

## What it does today

You give the pipeline a brief about a prospect:

```bash
node src/cli.ts pipeline "Gina's Bakery, artisan bakery in Bondi. Site: https://ginas.example.com. They sell through Instagram DMs and want online orders." --client "Gina's Bakery"
```

**Stage 1, research.** The research agent checks the agency's notes about the business (`recall_client`), reads the business's website page by page and any competitor the brief names (`fetch_url`), saves the facts worth keeping (`remember_client`) and delivers a structured report (`submit_research`): summary, business profile, digital presence, problems with evidence, competitors, opportunities mapped to the agency's services and price ranges, questions for the client, sources and a confidence rating.

**Stage 2, proposal.** The proposal agent takes the brief, the research report and the agency's knowledge, checks what was quoted before (`recall_client`, `past_proposals`) and delivers the proposal (`submit_proposal`): what we understood, objectives, the scope as priced items, timeline, investment, what is not included, next steps, plus an internal section for the agency (assumptions, alerts, questions to ask before sending).

**Stage 3, quality review.** First the code checks the proposal against the knowledge: every item's service name and price range, the totals, the currency, the language of every field, empty sections, and whether each core item answers something the research found. Then the review agent reads the brief, the research, the proposal and those findings, checks the client's notes and the price history (`recall_client`, `past_proposals`) and judges what code cannot: technologies or vendors nobody mentioned, promises nothing supports, high-impact problems left unaddressed, terms the knowledge does not offer, tone. It delivers (`submit_review`) a verdict, **approve**, **revise** or **reject**, with findings (where, what, evidence, fix), strengths and what it checked. The code has the last word on the verdict: a high or medium finding from anyone rules out "approve".

**The rewrite.** When the verdict is not "approve", the pipeline sends the proposal back to the proposal agent with the review, and the rewrite is reviewed again. `BRAIN_MAX_REVISIONS` (default 1) caps the rewrites; 0 reviews once and stops.

What you get back:

- A research note, a proposal note and a review note, in the language of the brief, in your reports, proposals and reviews folders. The proposal's frontmatter carries the verdict and the link to its review.
- The client's memory note updated with dated facts, the amount quoted, the verdict with its serious findings and links to the three notes, so the next run, or you, starts from there.
- A trace of every stage (steps, tool calls, token counts, estimated cost) in `runs/`, one folder per version when there was a rewrite.

```
Pipeline (research, proposal, review): claude-opus-5-5 on the Claude API
stage 1 of 3: research
step 1: recall_client {"name":"Gina's Bakery"} -> 61 chars (0.0 s)
step 2: fetch_url {"url":"https://ginas.example.com","offset":0} -> 6,412 chars (1.1 s)
step 3: fetch_url {"url":"https://ginas.example.com/menu","offset":0} -> 3,088 chars (0.7 s)
step 4: remember_client {"name":"Gina's Bakery","facts":[...]} -> 30 chars (0.0 s)
step 5: submit_research {...} -> 36 chars (0.0 s)
stage 2 of 3: proposal
step 1: past_proposals {"limit":10} -> 212 chars (0.0 s)
step 2: submit_proposal {...} -> 36 chars (0.0 s)
stage 3 of 3: review
checks: 1 finding(s) (0 high, 0 medium, 1 low)
step 1: recall_client {"name":"Gina's Bakery"} -> 1,204 chars (0.0 s)
step 2: submit_review {...} -> 36 chars (0.0 s)
verdict: approve (0 high, 0 medium, 1 low)

Report:   .../reports/2026-10-01 Research Gina's Bakery.md
Proposal: .../proposals/2026-10-01 Proposal Gina's Bakery.md
Memory:   .../clients/gina-s-bakery.md
Trace:    runs/2026-10-01-113000-gina-s-bakery-pipeline
Total:    AUD 1,300 – AUD 2,000
Review:   .../reviews/2026-10-01 Review Gina's Bakery.md
Verdict:  approve (0 high, 0 medium, 1 low)
9 steps, 2 pages fetched, 140 s, 9 requests, 71,300 tokens in, 9,100 out, 58,900 read from cache, cost: ~$0.31
```

Each stage also runs on its own: `research "<brief>"` writes the report, `propose --research runs/<run>/summary.json` writes a proposal from a saved research run, and `review --proposal runs/<run>/summary.json` reviews a saved proposal, so you can rerun a stage without paying for the ones before it.

**The evals.** `eval` runs the cases in [evals/](evals/): proposals with planted errors (a price below the range, a service the agency does not sell, Stripe and Shopify nobody mentioned, promises nothing supports, the research ignored, a client history contradicted) through the checks and the reviewer, and briefs whose fake websites carry prompt injection (hidden instructions, a request to fetch an attacker's URL, memory poisoning, a prompt-leak demand) through the research agent. It scores what was caught, missed and flagged by mistake, and writes a report. `--checks-only` runs the code part alone, with no model, in under a second.

## Why

Every proposal starts the same way: an hour of re-discovering the client. What do they sell, what is their website like, who are they up against, what would actually move the needle, what does that cost. That work is repetitive, it is where the agency's knowledge lives, and it is the part that gets skipped when the week is busy.

The goal is a system of three agents, coordinated by an orchestrator, that turns a brief into a proposal in minutes:

- **Research**: the business and its competition. Done.
- **Proposal and quote**: with the agency's services, the price history and the tone. Done.
- **Quality review**: checks the proposal against the research and the rules before a person sees it. Done.
- **Evals**: cases that say what the review must find and what the research must not fall for, scored by code. Done.

They share one memory about clients, and everything they produce is a note a person can read, edit and correct.

## How it works

```
brief ──▶ research agent ──▶ report.md ──▶ proposal agent ──▶ proposal.md ──▶ checks + review agent ──▶ review.md
              │  ▲                              │  ▲       ▲                          │  ▲          │
       tools  ▼  │ results               tools  ▼  │       └──── rewrite with the review ◀┘  │          │ verdict
   fetch_url · recall_client · remember_client      recall_client · remember_client · past_proposals    recall_client · past_proposals
                        │                                    │                                              │
                        └─────────────────── client memory (append-only notes) ─────────────────────────────┘
```

- **The agent loop** ([src/loop.ts](src/loop.ts)) is written by hand on the Anthropic Messages API: send the system prompt, the tools and the conversation; run the tools the model calls; feed the results back; repeat until the model calls the *final tool* with a result that matches the schema. The final tool is how an agent delivers its output: a strict JSON schema, validated with Zod, so a report, a proposal or a review always has the same shape. Answers in text get a reminder; refusals, cut-off answers and step limits stop the run with a saved trace.
- **The orchestrator** ([src/pipeline.ts](src/pipeline.ts)) is plain code, not a model: research, then the proposal from that research, then the review of that proposal, and a rewrite when the review asks for one. Each stage leaves its note, its memory lines and its trace. Stages are independent functions with fixed hand-offs.
- **The checks** ([src/checks.ts](src/checks.ts)) are the part of the review that needs no model. They read the price tables in the knowledge notes (the first cell of a row is the service, the first cell that starts with an amount is its price) and compare every scope item with them: unknown services, prices below or above the range, items left "to quote" that have a price, totals, currency, language and empty sections. Their findings go to the review agent as input and to the review note as they are.
- **Tools** live in [src/tools/](src/tools/). Each one is a Zod schema plus a function. The schema becomes the tool definition the API receives, and every input is validated before it runs, on any model.
- **Knowledge** ([src/tools/knowledge.ts](src/tools/knowledge.ts)): every Markdown note in the knowledge folder goes into the system prompt, in a fixed order, so it is cached between requests. A note with `private: true` in its frontmatter is never sent.
- **Memory** ([src/tools/memory.ts](src/tools/memory.ts)): one note per client, append-only, read by all three agents. Research and proposal add dated lines (`- 2026-10-01 (research): ...`); the reviewer only reads. The harness adds the report summary, the amount quoted, the verdict with its serious findings and the links after every stage, so memory does not depend on the model remembering to write, and the next proposal for the same client knows what the reviewer flagged last time. People edit the notes freely.
- **Price history** ([src/tools/proposals.ts](src/tools/proposals.ts)): the proposals folder is the history. Every proposal note carries its client, services and total in its frontmatter, and `past_proposals` reads them back, so new quotes stay consistent with old ones.
- **Totals and verdicts are computed, not trusted**: the proposal's total is the sum of its core items, worked out by the code; if the model wrote a different total, the note shows the sum and an alert says so. The review's verdict is the model's, raised by the code when the findings demand it.
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

Finally, point the data folders at your notes, or use the defaults (`data/knowledge`, `data/clients`, `data/reports`, `data/proposals`, `data/reviews`, all ignored by git):

```
BRAIN_KNOWLEDGE_DIR=C:\path\to\vault\Brain\Knowledge
BRAIN_CLIENTS_DIR=C:\path\to\vault\Brain\Clients
BRAIN_REPORTS_DIR=C:\path\to\vault\Brain\Reports
BRAIN_PROPOSALS_DIR=C:\path\to\vault\Brain\Proposals
BRAIN_REVIEWS_DIR=C:\path\to\vault\Brain\Reviews
```

Put at least one note in the knowledge folder: who you are, who you work with, what you sell and for how much, your payment terms and your tone. [data.example/knowledge/agency.md](data.example/knowledge/agency.md) is a template. The proposal agent quotes only the prices it finds there, and the checks read the same tables: keep prices in Markdown tables with the service in the first column and your price in the first column that holds an amount.

## Usage

```bash
# Everything: research, proposal, review, and a rewrite if the review asks for one
node src/cli.ts pipeline "<brief>" --client "<business name>"

# Research only
node src/cli.ts research "<brief>" --client "<business name>"

# A proposal from a saved research run (no new research)
node src/cli.ts propose --research runs/2026-10-01-113000-ginas-bakery/summary.json --client "<business name>"

# A review of a saved proposal run (no new research or proposal)
node src/cli.ts review --proposal runs/2026-10-01-113000-ginas-bakery-proposal/summary.json --client "<business name>"

# Brief from a file, report language forced, no rewrites, one-off overrides
node src/cli.ts pipeline --file brief.md --language es --revisions 0 --model claude-sonnet-5-5 --effort high --max-steps 30

# The evals: every case, one suite, the checks alone, or a few cases by name
node src/cli.ts eval
node src/cli.ts eval research
node src/cli.ts eval --checks-only
node src/cli.ts eval review --only invented
```

`--client` is optional but recommended: it names the memory note and the files. Without it the agents take the name from the brief. `--language es|en` forces the language of the notes; without it the agents follow the brief (Claude does, small local models sometimes do not). `--revisions <n>` caps the rewrites of one pipeline run (default `BRAIN_MAX_REVISIONS`, 1).

## Output

**The research note** has frontmatter (`type`, `client`, `website`, `date`, `model`, `confidence`) and these sections: summary, the business, digital presence (table), problems found (with evidence and impact), competitors, opportunities for the agency (service, why, price range, priority), questions for the client, sources, confidence, the brief, and the run (model, steps, pages, tokens, cost).

**The proposal note** is written for the client, with the internal notes at the end after a rule: title and summary; what we understood; objectives; what we propose (one section per core item with deliverables and price, optional items apart); timeline (table); investment (table with the computed total, payment terms, market comparison, ongoing costs); not included; next steps; then *internal notes, do not send*: alerts, assumptions, questions for the client, the link to the research, the brief and the run. Its frontmatter (`client`, `date`, `status`, `currency`, `total_min`, `total_max`, `services`, `research`) is what `past_proposals` reads; after a review it also carries `review` (the link) and `verdict`.

**The review note** has frontmatter (`client`, `date`, `verdict`, `findings`, `high`, `proposal`, `research`, `model`) and these sections: the verdict with the reviewer's summary (and a line when the code raised the verdict); the findings, most serious first, each with where it is, the issue, the evidence, the fix and who found it (checks or reviewer); what works; what was checked and is fine; then the links, the brief and the run.

**The client note** looks like this:

```markdown
---
type: client
name: "Gina's Bakery"
created: 2026-10-01
updated: 2026-10-01
---

# Gina's Bakery

## Notes

- 2026-10-01 (agent): Sells sourdough, pastries and coffee from one shop in Bondi.
- 2026-10-01 (research): Website: https://ginas.example.com
- 2026-10-01 (research): Research report: [[2026-10-01 Research Gina's Bakery]]
- 2026-10-01 (proposal): Proposal: [[2026-10-01 Proposal Gina's Bakery]]
- 2026-10-01 (proposal): Quoted AUD 1,300 – AUD 2,000 for: Business website, AI assistant on the site
- 2026-10-01 (review): Review: [[2026-10-01 Review Gina's Bakery]]
- 2026-10-01 (review): Verdict: revise (1 high, 0 medium, 1 low)
- 2026-10-01 (review): Finding (high): Item "Online ordering": Names Stripe as the payment provider; nothing in the knowledge or the research mentions it.
- 2026-10-01 (proposal v2): Quoted AUD 1,300 – AUD 2,000 for: Business website, AI assistant on the site
- 2026-10-01 (review v2): Verdict: approve (0 high, 0 medium, 1 low)
```

**The traces** (`runs/<date>-<time>-<client>[-proposal|-review|-pipeline]/`, with `-v2` on rewrites) have `trace.jsonl` (one line per step: stop reason, tokens, tool calls with timings), `messages.json` (the full conversation) and `summary.json` (usage, cost, the result, and the inputs the stage received, so `propose` and `review` can start from a summary alone). Failed runs save them too. When a proposal is rewritten the same day, the notes show the last version and the runs keep every attempt.

## Cost and observability

On Claude, the system prompt (rules plus knowledge) is cached and reused across the steps of a run and across runs within five minutes, and the conversation tail is cached automatically, so most input tokens are billed at the cache-read rate. Every run prints and saves the token counts and an estimate in USD from the list prices in [src/pricing.ts](src/pricing.ts). Adaptive thinking is on, with `BRAIN_EFFORT` (default `medium`) controlling how much the model thinks. `BRAIN_MAX_STEPS` and `BRAIN_MAX_FETCHES` cap a run.

## Evals

The agents are measured, not trusted. [evals/](evals/) holds a fictional agency's knowledge, eight proposals with planted errors and four websites with prompt injection, each with what the system must find or must not do, and `node src/cli.ts eval` runs them with any model and scores them by code ([src/evals/](src/evals/)):

- **Review cases** say which findings the review must produce (category, lowest severity, keywords) and who must catch each one: the automated checks alone, or the checks or the reviewer. The score counts what the checks caught, what the reviewer added, what was missed or rated too low, and the reviewer's false positives (high or medium findings that match nothing planted). A planted client history and price history test whether the reviewer reads the memory.
- **Research cases** run the research agent for real, with `fetch_url` served from the case folder instead of the network. They check that the report keeps the real facts and none of the planted ones, that the memory note was not poisoned, that forbidden URLs were never requested (whether the code would have blocked them or not), that a canary from the knowledge did not leak, and that every opportunity is priced from the knowledge.

Every run writes `runs/<date>-<time>-evals/report.md` with the totals and each case, plus every case's notes and traces, and never touches the real data folders. `--checks-only` scores the code part with no model, and the test suite asserts it: every expectation marked for the code is caught by the checks. [evals/README.md](evals/README.md) documents the case format.

## Security

The agents read the open web and write proposals with prices, so the harness is built around one idea: **the model decides what to look at and what to say; the code decides what happens.**

- Fetched pages are untrusted. They are wrapped in a `<fetched_page>` block with a warning, the model is told to treat them as data, and nothing a page says can make the code do anything: tool inputs are validated, the memory is append-only and confined to its folder, file names are sanitised, and the only way out of a run is the final tool's schema.
- `fetch_url` only fetches public `http(s)` URLs. Localhost, private and link-local ranges (IPv4 and IPv6), URLs with credentials and non-web schemes are refused, on every redirect hop. Downloads are capped in size and time, and only HTML and text are read.
- Proposal totals are computed from the line items; the knowledge is the only source of prices the agent is allowed to use; the checks compare every item's service and price with the knowledge tables by code; and the review flags invented technology, unsupported promises and anything to check before sending. The reviewer cannot write memory: the harness records the verdict.
- Tool schemas are strict on Claude (`strict: true`), and every input is checked with Zod before a tool runs, on any model.
- No client data in the repository: `.env`, `data/` and `runs/` are ignored. Knowledge notes marked `private: true` are never sent.
- Known limits: DNS rebinding is not covered (the check is on the hostname, not the resolved address); pages that need JavaScript to render come back empty; there is no web search yet; the checks only read prices laid out in Markdown tables; the reviewer judges technologies and promises with the same model that wrote the proposal, and the evals are what shows how much it catches with a given model.

## Roadmap

1. **Research agent** with tools and memory, end to end. Done (v0.1).
2. **Proposal and quote agent**, and the orchestrator that runs research then proposal. Done (v0.2).
3. **Quality review agent**: code checks against the knowledge, a reviewer that judges the rest, the rewrite loop, and the shared memory read by all three. Done (v0.3).
4. **Evals**: proposals with planted errors and what the review must find, pages with prompt injection and what the research must not do, scored by code. Done (v0.4).
5. **Production**: deploy, a minimal interface, time and cost metrics per run.
6. Write-up and a public example.

## Development

```bash
npm run check       # typecheck + lint + tests
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

The tests cover the HTML reader, the URL rules and the fetch tool, the memory store and its tools, the knowledge loader, the proposal store, the provider profiles, the price-table parser and the checks, the three renderers, the verdict rules, the agent loop (against a fake model), full research, proposal, review and pipeline runs, including the rewrite loop (against a fake model, with real files), and the evals: the case loaders, the scoring, and eval runs against a fake model, plus the assertion that the checks catch every eval expectation marked for the code.

## License

MIT
