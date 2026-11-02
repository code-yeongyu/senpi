export const DEFAULT_ERROR_RULE =
	"Never swallow errors silently; no shotgun debugging (unrelated edits, blind retries).";

export function buildPoliciesSection(options: { errorRule?: string } = {}): string {
	return `## Hard Limits

- No git commit unless user explicitly asked.
- Never suppress type errors, lint warnings, test failures; never delete/skip failing tests to go green.
- ${options.errorRule ?? DEFAULT_ERROR_RULE}
- Never present partial work as complete; no stub, placeholder, or no-op shipped as the feature.`;
}
