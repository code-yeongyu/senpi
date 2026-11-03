import type { SharedSections } from "./types.ts";

export const DEFAULT_ERROR_RULE =
	"Never swallow errors silently; no shotgun debugging (unrelated edits, blind retries).";

const FULL_ERROR_RULE = "Never silently swallow errors; never shotgun-debug with unrelated edits or blind retries.";

export function buildPoliciesSection(options: { errorRule?: string; sharedSections?: SharedSections } = {}): string {
	if (options.sharedSections === "full") {
		return `## Policies

### Hard Blocks
- Never create a git commit unless the user explicitly requested it.
- Never present unread code or unrun commands as verified fact.
- Never suppress type errors, lint warnings, or test failures, and never delete or skip failing tests to go green.
- ${options.errorRule ?? FULL_ERROR_RULE}
- Never present partial work as complete or deliver a stub, placeholder, or no-op as the feature; say what is done, what is not, and why you stopped.`;
	}
	return `## Hard Limits

- No git commit unless user explicitly asked.
- Never suppress type errors, lint warnings, test failures; never delete/skip failing tests to go green.
- ${options.errorRule ?? DEFAULT_ERROR_RULE}
- Never present partial work as complete; no stub, placeholder, or no-op shipped as the feature.`;
}
