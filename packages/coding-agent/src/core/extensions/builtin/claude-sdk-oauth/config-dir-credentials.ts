import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountSlot, assertValidAccountName } from "./accounts.ts";

const CLI_OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
] as const;

export function writeConfigDirCredential(agentDir: string, slot: AccountSlot, access: string): string {
	assertValidAccountName(slot.name);
	const directory = join(agentDir, "claude-sdk-oauth-accounts", slot.name);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	writeFileSync(
		join(directory, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: access,
				refreshToken: slot.refresh,
				expiresAt: slot.expires,
				scopes: CLI_OAUTH_SCOPES,
			},
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
	return directory;
}
