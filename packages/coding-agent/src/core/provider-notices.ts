/** Shared by provider diagnostics and transcript renderers; RPC carries the same message in details. */
export const LONG_CONTEXT_FALLBACK_DIAGNOSTIC = "claude_sdk_oauth_long_context_fallback";
export const LONG_CONTEXT_FALLBACK_NOTICE =
	"Claude refused the 1M context window - this request was retried on the same model at 200k";
