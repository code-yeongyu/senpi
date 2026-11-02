import { createHmac } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../../../../config.ts";
import { installSalt } from "../../../install-salt.ts";

const SALT_FILE = join("anthropic-subscription", "seat-digest-salt");

/**
 * An 8-hex digest of an account slot name keyed by a random per-install salt, so logs and
 * diagnostics can tell seats apart without naming them, and a guessed slot name ("env", an email
 * address) cannot be confirmed without this install's salt (oh-my-openagent#10304).
 */
export function seatDigest(accountName: string, agentDir: string = getAgentDir()): string {
	return createHmac("sha256", installSalt(agentDir, SALT_FILE)).update(accountName).digest("hex").slice(0, 8);
}
