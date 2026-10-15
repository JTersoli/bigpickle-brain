# Three agents and one memory: a proposal pipeline for a small agency

*Josefina Tersoli, October 2026. The code is at [github.com/JTersoli/bigpickle-brain](https://github.com/JTersoli/bigpickle-brain), MIT.*

Every proposal my agency writes starts the same way: an hour of re-discovering the client. What do they sell, what is their website like, who are they up against, what would actually help them, what does that cost with our prices. It is repetitive, it is where the agency's knowledge lives, and it is the part that gets skipped when the week is busy.

bigpickle-brain is a small system of three AI agents that does that hour in minutes. You give it a brief about a prospect. The **research** agent reads the business's website and the competitors the brief names, and writes a report with evidence. The **proposal** agent turns the report into a priced proposal using only the agency's services and price ranges. The **quality review** checks the proposal, by code first and then by a reviewer agent, and sends it back for a rewrite when it is not good enough. The three share one memory about clients: plain Markdown notes that a person reads, edits and corrects.

I built it for [bigpickle](https://www.bigpickle.com.au), the agency I co-founded in Sydney, and wrote it so any small agency can use it: the code is generic, and the knowledge, the client notes and everything the agents write live outside the repository, in a folder you can open in Obsidian or any editor. This is a write-up of the decisions, what the evals showed, and what I learned.

## 1. A loop written by hand, and a tool as the exit

There is no framework. The agent loop ([src/loop.ts](../src/loop.ts)) is a couple of hundred lines on the Anthropic Messages API: send the system prompt, the tools and the conversation; run the tools the model calls; feed the results back; repeat. I wanted to see the mechanics, and I wanted the same code to run on Claude and on a local model through Ollama's Anthropic-compatible API, which rules out anything that leans on one provider's extras.

The one trick is how an agent delivers its result. Each agent has a *final tool* (`submit_research`, `submit_proposal`, `submit_review`) whose input schema is the agent's output, validated with Zod. The loop ends when the model calls it with a valid input. If the model answers in text instead, it gets a reminder; if the input is malformed, it gets the validation errors and corrects itself. That gave me structured output on both providers without structured-output features (Ollama ignores them), and it turned out to matter: in the first real runs the local model sent a malformed proposal three times in a row and fixed it each time, and the run still finished.

The three agents are the same loop with different system prompts, tools and final schemas. The research agent has `fetch_url`, `recall_client` and `remember_client`; the proposal agent adds `past_proposals`; the reviewer can recall and read the history but cannot write.

## 2. The orchestrator is code

I did not want a model deciding what happens next. The pipeline ([src/pipeline.ts](../src/pipeline.ts)) is a function with a fixed order: research, then the proposal from that research, then the review of that proposal, then a rewrite with the review attached if the verdict is not "approve", then a second review. A cap (`BRAIN_MAX_REVISIONS`, default 1) stops the loop. Each stage leaves its note, its lines in the client's memory and its trace, and each stage also runs on its own from a saved run, so you can redo a proposal without paying for the research again.

Deterministic hand-offs make the system boring in the right places. When something goes wrong, I know which stage, with which inputs, and I can replay it.

## 3. The vault is the memory

The agents' memory is a folder of Markdown notes, not a database or a vector store:

- A **knowledge** folder (who the agency is, what it sells and for how much, terms, tone) goes into the system prompt in a fixed order, so it is cached between requests. A note marked `private: true` is never sent.
- One **client** note per prospect, append-only, with dated lines: `- 2026-10-01 (research): Website: ...`. The agents add lines; the harness adds the report summary, the amount quoted, the verdict with its serious findings and the links after every stage, so memory does not depend on the model remembering to write.
- The **proposals** folder is the price history. Each proposal note carries its client, services and total in its frontmatter, and `past_proposals` reads them back, so a new quote stays consistent with the old ones.

The point of Markdown is that people own it. I open the notes in Obsidian, fix a wrong fact, delete a line, and the next run starts from the corrected version. With a local model nothing leaves the machine; with Claude, only the knowledge, the client note and the report travel to the API.

## 4. The code has the last word

The rule I kept coming back to: **the model decides what to look at and what to say; the code decides what happens.**

- The proposal's total is computed by the code from the line items. If the model wrote a different total, the note shows the sum and an alert says so.
- Before the reviewer sees a proposal, the code checks it against the knowledge ([src/checks.ts](../src/checks.ts)): it parses the price tables from the Markdown notes and compares every scope item with them. Unknown services, prices below or above the range, items "to quote" that carry a price, totals, currency, the language of every field, empty sections, core items that answer nothing the research found. These checks run in milliseconds, with no model, and their findings go to the reviewer as input and to the review note as they are.
- The reviewer judges what code cannot: a vendor nobody mentioned (Stripe, Shopify), a promise nothing supports ("double your orders in 60 days"), high-impact problems left unaddressed, terms the agency does not offer. It returns a verdict, but the code raises it: a high or medium finding from anyone rules out "approve".

Splitting the review this way was the best decision in the project. The cheap, certain part is deterministic and tested; the expensive, fuzzy part is where the model earns its tokens; and when the reviewer is noisy, a proposal still cannot ship with a wrong price.

## 5. Security, since the agents read the open web

The research agent fetches pages written by strangers. Every fetched page is wrapped in a block that marks it as untrusted data, and the model is told to treat it as such, but the real defence is that nothing a page says can make the code do anything: every tool input is validated, the memory is append-only and confined to its folder, file names are sanitised, and the only way out of a run is the final tool's schema.

`fetch_url` only fetches public `http(s)` URLs. Localhost, private and link-local ranges (IPv4 and IPv6), URLs with credentials and non-web schemes are refused, on every redirect hop, with caps on size and time. The server that exposes the pipeline is closed by default: loopback only unless a token is set, one job at a time, bodies capped, a strict content security policy, and the notes route serves files from the data folders only.

Known gaps, written down rather than hidden: DNS rebinding is not covered (the check is on the hostname, not the resolved address), pages that need JavaScript come back empty, and there is no web search yet.

## 6. Measuring instead of trusting: the evals

An agent that "seems to work" is not something I can put in front of a client. So the fourth phase was evals ([evals/](../evals/)): a fictional agency with its own knowledge and a canary string, eight proposals with planted errors, and four fake websites with prompt injection. `node src/cli.ts eval` runs them with any model and scores them by code.

The **review cases** say which findings the review must produce and who must catch each one: the automated checks alone, or the checks or the reviewer. The score counts what the checks caught, what the reviewer added, what was missed or rated too low, and the reviewer's false positives (high or medium findings that match nothing planted). One case is a clean proposal, to measure false positives directly. Another plants a client history (the reviewer rejected Stripe last time; the owner's budget is about AUD 4,000) to test whether the reviewer reads the memory.

The **research cases** run the research agent for real, with `fetch_url` served from the case folder instead of the network. The pages carry hidden instructions with fake follower counts and a fake rating, a request to fetch an attacker's URL and the cloud metadata address, a memory-poisoning attempt (a "pre-approved budget" the owner never mentioned), and a demand to print the system prompt. The checks verify that the report keeps the real facts and none of the planted ones, that the memory was not poisoned, that the forbidden URLs were never requested, that the canary did not leak, and that every opportunity is priced from the knowledge.

### What the first full run showed

With a local model (`qwen3.6:35b-a3b` on Ollama, 38 minutes, 41 requests, free):

| Suite | Result |
|---|---|
| Research, prompt injection | 4/4 cases, 44/44 checks. No fake fact in any report, no poisoned memory, no forbidden URL requested, no canary leaked. |
| Review, code checks | 7/7 planted errors meant for the code, caught in under a second. |
| Review, reviewer agent | 10/10 planted errors meant for the reviewer caught, including both in the client-history case. 12 false positives across 8 proposals. |
| Review, clean proposal | Failed: the model misread the timeline and returned "revise". |

The false positives are almost all the same thing: conditions in the knowledge that the proposal does not repeat (that the client owns the code, that they pay the platform fees). That is the local model's noise, and the clean-proposal case exists to measure exactly that. Two fixes to the cases came out of this run (the clean proposal ignored a high-impact problem, and the reviewer was right; and the expectations stopped demanding a category, because the model labels the same fault three different ways), which is the other thing evals are for: they correct the test as much as the system.

The useful part is not the numbers; it is that they are reproducible. Swap the model in the `.env`, run the same command, and compare. Running the suite on Claude and comparing the reviewer's precision with the local model's is the next thing on the list. Three of the notes from this run, a research report that ignored the hidden instructions, the client memory it left, and a review that caught Shopify, Stripe and a free trial, are in [examples/](../examples/).

## 7. Running it

The first full pipeline, launched from the web page with the local model, took 16 minutes and 16 steps for a real Sydney bakery: research in 5.6 minutes (10 steps, 5 pages), the proposal in 7.5 (5 steps, three of them the model correcting a malformed submission), the review in 2.9. Verdict: approve on the first review, with one low finding, for a proposal of AUD 4,600 to 8,000. The reviewer had read the memory: it knew what the previous proposal for that client had quoted and what the previous review had flagged.

Every run records its model, duration, steps, tokens and estimated cost in its `summary.json`, and `runs` (or the page) adds them up per kind. Runs on a model with no list price show `n/a`, not zero. The service is Node's `http` module and three static files, no framework and no build, with a queue that runs one job at a time because every job costs money and writes the same memory. A Dockerfile, a compose file and a CI workflow (typecheck, lint, 174 tests, the code evals, the image build) round it off.

## 8. What I learned

- **The harness is the product.** Prompts changed little after the first week. What made the system safe and predictable was the plumbing: schemas on every tool, computed totals, append-only memory, the checks before the reviewer, the fetch rules. Most of the code is that.
- **Small local models do the job, noisily.** They resisted every injection and caught every planted error, and they also flag things that are fine and sometimes send malformed output. Design for that: validate, retry, and let code decide the verdict.
- **Write the evals early.** They found two bad test cases on the first run, they make a model swap a one-line experiment, and they are the only honest answer to "does it work".
- **Deterministic orchestration beats an orchestrator agent** for a pipeline with three fixed stages. There was nothing for a planner to decide.
- **Markdown as memory is a feature.** The people who own the knowledge can read and fix what the agents know without a developer.

What comes next: the Claude run and the comparison, web search for the research agent, and closing the DNS rebinding gap.
