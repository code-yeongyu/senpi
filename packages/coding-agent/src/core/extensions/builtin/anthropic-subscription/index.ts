import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readByProviderId } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../../config.ts";
import { FileAuthStorageBackend } from "../../../auth-storage.ts";
import type { ExtensionAPI } from "../../types.ts";
import { registerClaudeAccountCommand } from "./account-command.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import type { AnthropicSubscriptionCredential } from "./accounts.ts";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import { createOAuthConfig } from "./oauth-login.ts";
import { registerSessionRegistry } from "./session-registry-wiring.ts";
import {
	type AnthropicSubscriptionProviderSettings,
	loadAnthropicSubscriptionProviderSettingsFromDisk,
} from "./settings.ts";
import { streamAnthropicSubscription } from "./stream.ts";

export { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
export type AnthropicSubscriptionExtensionDeps = {
	readAmbientAuthStatus?: () => Promise<boolean>;
	/** Overrides the on-disk provider settings the auth predicate consults. */
	readSettings?: () => AnthropicSubscriptionProviderSettings;
};

const MODELS = getModels("anthropic").map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: model.reasoning,
	input: model.input,
	cost: model.cost,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
	thinkingLevelMap: {
		...model.thinkingLevelMap,
		minimal: null,
	},
}));

function readStoredCredential(providerId: string): AnthropicSubscriptionCredential | undefined {
	const authPath = join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, AnthropicSubscriptionCredential>;
		// Read boundary (senpi#1989): this raw read bypasses AuthStorage, so it
		// never sees the auth.json key migration. An auth.json still keyed by the
		// legacy provider id would report the lane logged out with no error at
		// all, so try the canonical key first and then the legacy spelling.
		// `anthropic` is untouched by the rename and still resolves exactly.
		return readByProviderId(data, providerId);
	} catch {
		return undefined;
	}
}

export function registerAnthropicSubscriptionExtension(
	pi: ExtensionAPI,
	deps: AnthropicSubscriptionExtensionDeps = {},
): void {
	registerClaudeAccountCommand(pi);
	registerSessionRegistry(pi);
	pi.registerProvider(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, {
		baseUrl: CLAUDE_SDK_OAUTH_API_ID,
		api: CLAUDE_SDK_OAUTH_API_ID,
		models: MODELS,
		streamSimple: streamAnthropicSubscription,
		// A verbatim `enabled: false` is the kill switch: the lane cannot serve, so
		// it must not consume an implicit fallback-expansion slot. An absent flag
		// stays eligible - an explicit senpi-side login keeps the lane usable.
		fallbackEligible: () => {
			try {
				const settings = deps.readSettings
					? deps.readSettings()
					: loadAnthropicSubscriptionProviderSettingsFromDisk(process.cwd());
				return settings.enabled !== false;
			} catch {
				return true;
			}
		},
		oauth: createOAuthConfig({
			readCurrent: async () => readStoredCredential(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID),
			readAmbientAuthStatus: deps.readAmbientAuthStatus,
			readSettings: () => {
				try {
					const settings = deps.readSettings
						? deps.readSettings()
						: loadAnthropicSubscriptionProviderSettingsFromDisk(process.cwd());
					return { tokenInjection: settings.tokenInjection, enabled: settings.enabled };
				} catch {
					return undefined;
				}
			},
			readAnthropicCredential: async () => {
				const credential = readStoredCredential("anthropic");
				return credential && typeof credential.access === "string"
					? { access: credential.access, refresh: credential.refresh, expires: credential.expires }
					: undefined;
			},
			removeAnthropicCredential: async () => {
				// The import is a move, not a copy: one single-use grant must never
				// live in two stores that refresh it independently (omo#7084).
				const backend = new FileAuthStorageBackend();
				await backend.withLockAsync(async (current) => {
					if (current === undefined) return { result: undefined };
					const data = JSON.parse(current) as Record<string, unknown>;
					if (!("anthropic" in data)) return { result: undefined };
					delete data.anthropic;
					return { result: undefined, next: JSON.stringify(data, null, 2) };
				});
			},
		}),
	});
}

export default function anthropicSubscriptionExtension(pi: ExtensionAPI): void {
	registerAnthropicSubscriptionExtension(pi);
}
