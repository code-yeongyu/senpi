export const DEFAULT_ERROR_RULE =
	"Never silently swallow errors; never shotgun-debug with unrelated edits or blind retries.";

export function buildPoliciesSection(options: { errorRule?: string } = {}): string {
	return `## Hard Limits

- Never create a git commit unless the user explicitly requested it.
- Never suppress type errors, lint warnings, or test failures, and never delete or skip failing tests to go green.
- ${options.errorRule ?? DEFAULT_ERROR_RULE}
- Never present partial work as complete or deliver a stub, placeholder, or no-op as the feature.`;
}
