import { type PromptSurface, type SharedSections, type TerminalOrApp, terminalOrApp } from "./types.ts";

export type TestDisciplineRule = {
	id:
		| "deterministic-tests"
		| "fixed-wait-ban"
		| "event-timeout-pattern"
		| "mock-contract-integrity"
		| "prompt-behavior-coverage"
		| "single-pass-runner";
	concern: "test-determinism" | "async-test-orchestration" | "mock-contracts" | "prompt-tests" | "test-runner";
	directive: string;
	/** The rule as worded before the senpi#5335 diet, rendered for `sharedSections: "full"` (senpi#5665). */
	fullDirective: string;
};

export const TEST_DISCIPLINE_RULES = [
	{
		id: "deterministic-tests",
		concern: "test-determinism",
		directive: "Reading/editing test code: nondeterminism = bug; no passing by timing luck.",
		fullDirective:
			"When you read or edit test code, treat nondeterminism as a bug; tests must not pass by timing luck.",
	},
	{
		id: "fixed-wait-ban",
		concern: "async-test-orchestration",
		directive: "Fixed sleeps, polling delays, wait-for-time: forbidden unless time itself is under test.",
		fullDirective:
			"Unless time itself is the behavior under test, fixed sleeps, polling delays, and wait-for-time patterns are forbidden.",
	},
	{
		id: "event-timeout-pattern",
		concern: "async-test-orchestration",
		directive:
			"Async: subscribe to the exact event/state change before triggering, then await it with a bounded timeout.",
		fullDirective:
			"For async behavior, subscribe to the exact event or state change before triggering the action, then await that signal with a bounded timeout.",
	},
	{
		id: "mock-contract-integrity",
		concern: "mock-contracts",
		directive: "Mocks keep the asserted behavior; never isolate so hard the integration cannot fail.",
		fullDirective:
			"Mocks must preserve the behavior being asserted; do not isolate so heavily that the integration under test cannot fail.",
	},
	{
		id: "prompt-behavior-coverage",
		concern: "prompt-tests",
		directive:
			"Never pin prose, prompt wording, or doc text with a test; test machine-consumed values only (parsed fields, sentinel tokens, shipped-copy equality). Pure-prose change = no new test.",
		fullDirective:
			"Never pin prose, prompt wording, or doc text with a test; test only machine-consumed values (parsed fields, sentinel tokens, shipped-copy equality). A pure-prose change ships with no new test.",
	},
	{
		id: "single-pass-runner",
		concern: "test-runner",
		directive:
			"Run the relevant test command once, make that pass reliable; Bun targets: bun test passes in a single run.",
		fullDirective:
			"Run the relevant test command once and make that pass reliable; for Bun test targets, bun test must pass in a single run.",
	},
] as const satisfies readonly TestDisciplineRule[];

export function buildTestDisciplineSection(sharedSections: SharedSections = "diet"): string {
	const lines = ["### Test Discipline"];
	for (const rule of TEST_DISCIPLINE_RULES) {
		lines.push(`- ${sharedSections === "full" ? rule.fullDirective : rule.directive}`);
	}
	return lines.join("\n");
}

/**
 * The app surface's claim audit (senpi#2377): a check that could not run is covered by what did run,
 * and tool and hook feedback stays with the agent. Every app-surface verification rule renders it.
 */
export const APP_UNRUN_CHECK_RULE =
	"A check that did not run is covered by the evidence that did run; name it only when no other evidence supports the claim. Replies render in an app, so tool and hook feedback (comment-checker findings, language-server availability, internal notices) is for you to act on: it reaches the user only when it changes what they get, and an unavailable tool or hook never does by itself.";

const CLAIM_AUDIT: Record<TerminalOrApp, string> = {
	terminal: "evidence-backed work only, flag unverified explicitly, failing tests with output.",
	app: `evidence-backed work only, failing tests with output. ${APP_UNRUN_CHECK_RULE}`,
};

const FULL_CLAIM_AUDIT: Record<TerminalOrApp, string> = {
	terminal:
		"report only evidence-backed work, flag the unverified explicitly, and report failing tests with the output.",
	app: `report only evidence-backed work and report failing tests with the output. ${APP_UNRUN_CHECK_RULE}`,
};

export function buildVerificationSection(
	options: { surface?: PromptSurface; sharedSections?: SharedSections } = {},
): string {
	if (options.sharedSections === "full") {
		return `## Verification

Tier the scope, never the rigor.

- V1 (single-file non-behavioral edits): diagnostics on that file. Done.
- V2 (single-domain behavioral edits): diagnostics on changed files in parallel, related tests, one execution of the affected runnable entry point when one exists.
- V3 (multi-file or cross-cutting work): diagnostics on every changed file, related tests, build, manual exercise of user-visible behavior through its real surface.

${buildTestDisciplineSection("full")}

"Should pass" is not verification - run the validator. Before reporting progress, audit each claim against a tool result from this session: ${FULL_CLAIM_AUDIT[terminalOrApp(options.surface ?? "terminal")]} Fix failures your change caused and any that sit in the code you changed; note other pre-existing failures separately.`;
	}
	return `## Verification

Tier the scope, never the rigor.

- V1 single-file non-behavioral edit: diagnostics on that file. Done.
- V2 single-domain behavioral edit: diagnostics on changed files in parallel + related tests + one run of affected runnable entry point if any.
- V3 multi-file / cross-cutting: diagnostics on every changed file + related tests + build + manual exercise of user-visible behavior through its real surface.

${buildTestDisciplineSection()}

Before reporting progress: audit each claim against a tool result from this session; ${CLAIM_AUDIT[terminalOrApp(options.surface ?? "terminal")]} Fix failures your change caused and any that sit in the code you changed; note other pre-existing failures separately.`;
}
