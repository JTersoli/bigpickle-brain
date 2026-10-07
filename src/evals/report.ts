import { describeUsage } from '../pricing.ts';
import type { EvalOutcome, ResearchCaseResult, ReviewCaseResult } from './run.ts';

/** The lines the CLI prints after a run: one per case, then the totals. */
export function summarizeEvals(outcome: EvalOutcome): string[] {
	const lines: string[] = [];
	if (outcome.review.length > 0) {
		lines.push(`Review evals (${outcome.checksOnly ? 'checks only' : 'checks + review agent'}):`);
		for (const result of outcome.review) {
			lines.push(`  ${mark(result.score.pass)} ${result.name}: ${reviewLine(result)}`);
		}
		lines.push(`  ${reviewTotals(outcome.review, outcome.checksOnly)}`);
	}
	if (outcome.research.length > 0) {
		lines.push('Research evals (prompt injection):');
		for (const result of outcome.research) {
			lines.push(`  ${mark(result.score.pass)} ${result.name}: ${researchLine(result)}`);
		}
		lines.push(`  ${researchTotals(outcome.research)}`);
	}
	return lines;
}

/** The report as a Markdown note: totals first, then every case with what was caught, missed and flagged. */
export function renderEvalReport(outcome: EvalOutcome): string {
	const lines: string[] = [];
	lines.push('---');
	lines.push('type: evals');
	lines.push(`date: ${outcome.date}`);
	lines.push(`model: "${outcome.model.replace(/"/g, "'")}"`);
	lines.push(`mode: ${outcome.checksOnly ? 'checks' : 'full'}`);
	lines.push(`review_cases: ${outcome.review.length}`);
	lines.push(`review_passed: ${outcome.review.filter((result) => result.score.pass).length}`);
	lines.push(`research_cases: ${outcome.research.length}`);
	lines.push(`research_passed: ${outcome.research.filter((result) => result.score.pass).length}`);
	lines.push('---');
	lines.push('');
	lines.push(`# Evals: ${outcome.date}`);
	lines.push('');
	lines.push(`- Model: ${outcome.provider}`);
	lines.push(`- Mode: ${outcome.checksOnly ? 'checks only (no model)' : 'checks and agents'}`);
	lines.push(`- Duration: ${(outcome.durationMs / 1000).toFixed(0)} s`);
	lines.push(`- Tokens: ${describeUsage(outcome.usage, outcome.cost)}`);
	lines.push('');

	if (outcome.review.length > 0) {
		lines.push('## Review: proposals with planted errors');
		lines.push('');
		lines.push(reviewTotals(outcome.review, outcome.checksOnly));
		lines.push('');
		lines.push('| Case | Result | Caught | Verdict | Expected | False positives | Time | Cost |');
		lines.push('|---|---|---|---|---|---|---|---|');
		for (const result of outcome.review) {
			const cost = result.cost === null ? 'n/a' : `$${result.cost.toFixed(4)}`;
			lines.push(
				`| ${result.name} | ${result.score.pass ? 'pass' : 'fail'} | ${result.score.caught}/${result.score.required} | ${result.error ? 'error' : result.score.verdict} | ${result.expected.verdict} | ${result.score.falsePositives.length} | ${(result.durationMs / 1000).toFixed(0)} s | ${cost} |`,
			);
		}
		lines.push('');
		for (const result of outcome.review) {
			lines.push(`### ${result.name}: ${result.score.pass ? 'pass' : 'fail'}`);
			lines.push('');
			if (result.description) {
				lines.push(result.description);
				lines.push('');
			}
			if (result.error) {
				lines.push(`The run failed: ${result.error}`);
				lines.push('');
			}
			lines.push(`Verdict: ${result.error ? 'none (run failed)' : result.score.verdict}; expected ${result.expected.verdict}${result.score.verdictOk ? '' : ' (wrong)'}.`);
			lines.push('');
			for (const entry of result.score.expectations) {
				const status = entry.caughtBy ? `caught by the ${entry.caughtBy === 'code' ? 'checks' : 'reviewer'}` : entry.underrated ? 'found but rated too low' : entry.required ? 'missed' : 'not tested in checks-only mode';
				const matched = entry.matched ? ` ${entry.matched}` : '';
				lines.push(`- **${entry.expectation.id}** (${entry.expectation.severity}, by ${entry.expectation.by}): ${status}.${matched}`);
			}
			if (result.score.expectations.length === 0) {
				lines.push('- Nothing to find: the proposal is correct.');
			}
			if (result.score.falsePositives.length > 0) {
				lines.push('');
				lines.push('False positives (high or medium findings of the reviewer that match nothing expected):');
				for (const finding of result.score.falsePositives) {
					lines.push(`- [${finding.severity}] [${finding.category}] ${oneLine(finding.where)}: ${oneLine(finding.issue)} Evidence: ${oneLine(finding.evidence) || 'none'}`);
				}
			}
			const others = result.findings.filter((finding) => finding.source === 'model' && finding.severity === 'low');
			if (others.length > 0) {
				lines.push('');
				lines.push(`Low findings of the reviewer: ${others.length}.`);
			}
			lines.push('');
		}
	}

	if (outcome.research.length > 0) {
		lines.push('## Research: pages with prompt injection');
		lines.push('');
		lines.push(researchTotals(outcome.research));
		lines.push('');
		lines.push('| Case | Result | Checks | Pages fetched | Time | Cost |');
		lines.push('|---|---|---|---|---|---|');
		for (const result of outcome.research) {
			const cost = result.cost === null ? 'n/a' : `$${result.cost.toFixed(4)}`;
			lines.push(`| ${result.name} | ${result.score.pass ? 'pass' : 'fail'} | ${result.score.passed}/${result.score.checks.length} | ${result.score.fetchAttempts.length} | ${(result.durationMs / 1000).toFixed(0)} s | ${cost} |`);
		}
		lines.push('');
		for (const result of outcome.research) {
			lines.push(`### ${result.name}: ${result.score.pass ? 'pass' : 'fail'}`);
			lines.push('');
			if (result.description) {
				lines.push(result.description);
				lines.push('');
			}
			if (result.error) {
				lines.push(`The run failed: ${result.error}`);
				lines.push('');
			}
			for (const check of result.score.checks) {
				lines.push(`- ${check.ok ? 'ok' : 'FAIL'} ${check.kind} "${check.target}": ${check.detail}`);
			}
			if (result.score.fetchAttempts.length > 0) {
				lines.push('');
				lines.push(`Fetches: ${result.score.fetchAttempts.join(', ')}`);
			}
			lines.push('');
		}
	}

	return lines.join('\n');
}

function reviewLine(result: ReviewCaseResult): string {
	if (result.error) {
		return `run failed (${result.error})`;
	}
	const parts = [`${result.score.caught}/${result.score.required} caught`, `verdict ${result.score.verdict}${result.score.verdictOk ? '' : ` (expected ${result.expected.verdict})`}`];
	if (result.score.falsePositives.length > 0) {
		parts.push(`${result.score.falsePositives.length} false positive(s)`);
	}
	const underrated = result.score.expectations.filter((entry) => entry.underrated).length;
	if (underrated > 0) {
		parts.push(`${underrated} rated too low`);
	}
	return parts.join(', ');
}

function researchLine(result: ResearchCaseResult): string {
	if (result.error) {
		return `run failed (${result.error}); ${result.score.passed}/${result.score.checks.length} checks`;
	}
	const failed = result.score.checks.filter((check) => !check.ok);
	const parts = [`${result.score.passed}/${result.score.checks.length} checks`];
	if (failed.length > 0) {
		parts.push(failed.map((check) => `${check.kind} "${check.target}"`).join('; '));
	}
	return parts.join(': ');
}

function reviewTotals(results: ReviewCaseResult[], checksOnly: boolean): string {
	const passed = results.filter((result) => result.score.pass).length;
	const required = results.reduce((sum, result) => sum + result.score.required, 0);
	const caught = results.reduce((sum, result) => sum + result.score.caught, 0);
	const byCode = results.reduce((sum, result) => sum + result.score.expectations.filter((entry) => entry.caughtBy === 'code').length, 0);
	const byModel = results.reduce((sum, result) => sum + result.score.expectations.filter((entry) => entry.caughtBy === 'model').length, 0);
	const falsePositives = results.reduce((sum, result) => sum + result.score.falsePositives.length, 0);
	const parts = [`${passed}/${results.length} cases passed`, `${caught}/${required} expected findings caught (${byCode} by the checks${checksOnly ? '' : `, ${byModel} by the reviewer`})`];
	if (!checksOnly) {
		parts.push(`${falsePositives} false positive(s)`);
	}
	return parts.join(', ');
}

function researchTotals(results: ResearchCaseResult[]): string {
	const passed = results.filter((result) => result.score.pass).length;
	const checks = results.reduce((sum, result) => sum + result.score.checks.length, 0);
	const ok = results.reduce((sum, result) => sum + result.score.passed, 0);
	return `${passed}/${results.length} cases passed, ${ok}/${checks} checks passed`;
}

function mark(pass: boolean): string {
	return pass ? 'PASS' : 'FAIL';
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
