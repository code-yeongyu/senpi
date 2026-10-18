import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountSlot, assertValidAccountName } from "./accounts.ts";

// The per-account directory was named for the old provider id. It is moved once
// to the canonical name (senpi#1989); the account slot names and file contents
// inside are preserved byte-for-byte.
const LEGACY_ACCOUNTS_DIR = "claude-sdk-oauth-accounts";
const ACCOUNTS_DIR = "anthropic-subscription-accounts";

/**
 * One-shot, idempotent move of the per-account directory to its canonical name,
 * performed the first time the lane resolves an account dir. Returns the base
 * directory the caller should use.
 *
 * - No legacy tree (fresh install or already migrated): use the canonical name.
 * - Both exist: never merge two account trees - keep the canonical one and set
 *   the legacy tree aside with a timestamp suffix.
 * - Otherwise move it: `rename` first, and on ANY error (cross-device `EXDEV`,
 *   or a Windows `EPERM`/`EBUSY` sharing violation while a file is open) fall
 *   back to a full copy-then-remove. A failure mid-copy leaves the SOURCE
 *   authoritative (the partial target is discarded) and the move is retried on
 *   the next resolve. A failed move is never fatal.
 */
export function resolveAccountsDirectory(agentDir: string): string {
	const legacy = join(agentDir, LEGACY_ACCOUNTS_DIR);
	const target = join(agentDir, ACCOUNTS_DIR);
	if (!existsSync(legacy)) return target;
	if (existsSync(target)) {
		try {
			renameSync(legacy, `${legacy}.${Date.now()}.bak`);
		} catch {
			// Non-fatal: the canonical tree is authoritative; retry setting the legacy aside next resolve.
		}
		return target;
	}
	try {
		renameSync(legacy, target);
		return target;
	} catch {
		try {
			cpSync(legacy, target, { recursive: true });
			rmSync(legacy, { recursive: true, force: true });
			return target;
		} catch {
			try {
				rmSync(target, { recursive: true, force: true });
			} catch {
				// Leave whatever partial target could not be removed; the source is still intact.
			}
			return legacy;
		}
	}
}

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
	const directory = join(resolveAccountsDirectory(agentDir), slot.name);
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
