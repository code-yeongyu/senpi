/**
 * The Anthropic Subscription provider id, in a module with no imports, so core modules on the model runtime's import
 * path can name the provider without loading account management, the credential pool and zod (senpi#4436).
 */
export const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";
