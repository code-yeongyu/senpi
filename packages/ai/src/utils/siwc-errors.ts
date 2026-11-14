export { siwcRecoveryFromDiagnostic } from "./provider-diagnostic-carrier.ts";

// Sign in with ChatGPT, observed 401 (senpi#6643): "You have insufficient permissions for this operation.
// Missing scopes: api.responses.write. Check that you have the correct role in your organization ...".
// The token is valid; the account behind it is not entitled to the Responses API.
// Scope names are dotted, so the list runs to the end of the line, not to the first dot (#6653 review L1).
const MISSING_RESPONSES_SCOPE = /\bMissing scopes?:[^\n]*?\bapi\.responses\.write\b/i;

export const SIWC_MISSING_RESPONSES_SCOPE_GUIDANCE =
	"This ChatGPT account or plan does not have access to the Responses API through Sign in with ChatGPT " +
	"(missing scope api.responses.write). Signing in again will not change that: check that plan usage is " +
	"enabled for this account or workspace, or use an OpenAI API key.";

export function isSiwcMissingResponsesScope(text: string): boolean {
	return MISSING_RESPONSES_SCOPE.test(text);
}
