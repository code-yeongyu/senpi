/**
 * Lazy boundary for the Claude CLI sign-out a provider logout runs first (senpi#4436). `credential-accounts.ts` loads
 * the credential-pool state store and zod, which installs zod's globals; `ModelRuntime` needs it only on an Anthropic
 * Subscription logout, so it is imported here on that first use instead of on every `ModelRuntime` import
 * (`test/model-runtime-text-toolcall-recovery.test.ts` fails if a static edge reappears). Follows the repository's
 * documented lazy-boundary pattern (`packages/ai/src/api/*.lazy.ts`).
 */
import { normalizeProviderId } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth-storage.ts";

export async function signOutClaudeCliSlotsForLogout(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (normalizeProviderId(provider) !== "anthropic-subscription") return [];
	const accounts = await import("./credential-accounts.ts");
	return accounts.signOutClaudeCliSlotsForLogout(storage, provider, env, signal);
}
