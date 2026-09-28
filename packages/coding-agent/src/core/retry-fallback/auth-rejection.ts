/**
 * Credential-class provider failures: the stored login or API key was rejected
 * (401, a revoked OAuth token, an invalid key, every pooled account blocked).
 * The rejection belongs to the provider's credential, not to one model, so every
 * later rung on the same provider fails identically; the fallback chain skips
 * them for the rest of the turn instead of spending one failed request per rung.
 */
const CREDENTIAL_REJECTION_PATTERN = new RegExp(
	[
		"\\b401\\b",
		"unauthori[sz]ed",
		"authentication[_ ](?:error|failed)",
		"invalid[_ -]?x-api-key",
		"invalid api[_ -]?key",
		"incorrect api[_ -]?key",
		"token has been revoked",
		"invalid_grant",
	].join("|"),
	"i",
);

export function isCredentialRejectionMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && CREDENTIAL_REJECTION_PATTERN.test(errorMessage);
}
