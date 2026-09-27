import { museCodeCliApi } from "../api/muse-code-cli.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { MUSE_CODE_SUBSCRIPTION_MODELS } from "./muse-code-subscription.models.ts";

/** Sentinel base URL: requests go to the local `muse` CLI, never to a Meta endpoint. */
export const MUSE_CODE_CLI_BASE_URL = "muse://local";

/**
 * Muse Code subscription models, served by the official `muse` CLI.
 *
 * Sign in once with `muse login`; the CLI owns that credential. The api-key
 * resolver only marks the provider available and carries no secret.
 */
export function museCodeSubscriptionProvider(): Provider<"muse-code-cli"> {
	return createProvider({
		id: "muse-code-subscription",
		name: "Muse Code (subscription, via muse CLI)",
		baseUrl: MUSE_CODE_CLI_BASE_URL,
		auth: {
			apiKey: {
				name: "Muse CLI sign-in",
				resolve: async () => ({ auth: { apiKey: "muse-cli" }, source: "muse CLI" }),
			},
		},
		models: Object.values(MUSE_CODE_SUBSCRIPTION_MODELS),
		api: museCodeCliApi(),
	});
}
