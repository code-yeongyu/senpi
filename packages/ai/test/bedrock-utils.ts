/**
 * Utility functions for Amazon Bedrock tests
 */

function hasBedrockRegion(): boolean {
	return !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
}

/**
 * Check if any valid AWS credentials are configured for Bedrock.
 * Returns true if any of the following are set:
 * - AWS_PROFILE (named profile from ~/.aws/credentials)
 * - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (IAM keys)
 * - AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)
 *
 * Bedrock tests also require an explicit region. This avoids auto-enabling
 * live E2E coverage in shells that only have a bearer token present.
 */
export function hasBedrockCredentials(): boolean {
	return !!(
		hasBedrockRegion() &&
		(process.env.AWS_PROFILE ||
			(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
			process.env.AWS_BEARER_TOKEN_BEDROCK)
	);
}
