import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../../config.ts";
import type { ExtensionAPI } from "../../types.ts";
import { registerClaudeAccountCommand } from "./account-command.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import type { ClaudeSdkOauthCredential } from "./accounts.ts";
import { createOAuthConfig } from "./oauth-login.ts";
import { registerSessionRegistry } from "./session-registry-wiring.ts";
import { loadClaudeSdkOauthProviderSettingsFromDisk } from "./settings.ts";
import { streamClaudeSdkOauth } from "./stream.ts";

export { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";

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

function readStoredCredential(providerId: string): ClaudeSdkOauthCredential | undefined {
	const authPath = join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, ClaudeSdkOauthCredential>;
		return data[providerId];
	} catch {
		return undefined;
	}
}

export default function claudeSdkOauthExtension(pi: ExtensionAPI): void {
	registerClaudeAccountCommand(pi);
	registerSessionRegistry(pi);
	pi.registerProvider(CLAUDE_SDK_OAUTH_PROVIDER_ID, {
		baseUrl: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		api: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		apiKey: "claude-sdk-oauth-managed",
		models: MODELS,
		streamSimple: streamClaudeSdkOauth,
		oauth: createOAuthConfig({
			readCurrent: async () => readStoredCredential(CLAUDE_SDK_OAUTH_PROVIDER_ID),
			readAnthropicCredential: async () => {
				const credential = readStoredCredential("anthropic");
				return credential && typeof credential.access === "string"
					? { access: credential.access, refresh: credential.refresh, expires: credential.expires }
					: undefined;
			},
			readSettings: () => loadClaudeSdkOauthProviderSettingsFromDisk(process.cwd()),
		}),
	});
}
