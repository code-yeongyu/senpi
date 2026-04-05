export function buildPoliciesSection(): string {
	return `## Policies

### Hard Blocks
- Never use \`as any\`.
- Never use \`ts-ignore\` or related suppression comments.
- Never create a git commit unless the user explicitly requested it.
- Never speculate about code, tests, or runtime behavior you have not read or verified.

### Anti-Patterns
- Do not leave empty \`catch\` blocks.
- Do not delete failing tests to make the suite pass.
- Do not do shotgun debugging with unrelated edits or blind retries.`;
}
