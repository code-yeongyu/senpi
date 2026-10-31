/**
 * Named claude CLI account fixtures for lane tests (senpi#4436). Stored Claude accounts are CLI accounts: a turn
 * gets `CLAUDE_CONFIG_DIR=<agentDir>/anthropic-subscription-claude/<dirId>` and no token, so a scripted query tells
 * the accounts apart by that dir. Each name maps to a fixed dir id, and the shared Claude root is a temp dir, so no
 * test links into the real `~/.claude`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import type { ClaudeCliAccountSlot } from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";

const namesByDirId = new Map<string, string>();
let sharedRoot: string | undefined;

export function cliDirId(name: string): string {
	const dirId = createHash("sha256").update(name).digest("hex").slice(0, 32);
	namesByDirId.set(dirId, name);
	return dirId;
}

export function cliSlot(name: string, extra: Partial<ClaudeCliAccountSlot> = {}): ClaudeCliAccountSlot {
	return { name, source: "login", store: "claude-cli", dirId: cliDirId(name), ...extra };
}

/** The account a turn ran on, read from the config dir the lane handed the SDK child. */
export function cliAccountOf(env: Record<string, string | undefined> | undefined): string {
	const configDir = env?.CLAUDE_CONFIG_DIR;
	return (configDir === undefined ? undefined : namesByDirId.get(basename(configDir))) ?? "missing";
}

/** A lane environment whose shared Claude root is a temp dir instead of the real `~/.claude`. */
export function cliLaneEnv(extra: Record<string, string> = {}): Record<string, string> {
	if (sharedRoot === undefined) {
		const root = mkdtempSync(`${tmpdir()}/senpi-claude-cli-shared-`);
		process.once("exit", () => rmSync(root, { recursive: true, force: true }));
		sharedRoot = root;
	}
	return { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: sharedRoot, ...extra };
}
