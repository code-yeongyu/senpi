import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ClaudeCliLoginDeps } from "../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "claude-cli-auth", "fake-claude.mjs");
const roots: string[] = [];

/**
 * CLI sign-in deps for login tests that do not exercise the CLI itself: the fake `claude` signs in at once and
 * reports a claude.ai login, the store is in memory, and the connection test passes without a turn.
 */
export function fakeClaudeCliLogin(): ClaudeCliLoginDeps {
	const root = mkdtempSync(join(tmpdir(), "senpi-fake-claude-login-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const store = new InMemoryCredentialStore();
	return {
		agentDir: () => agentDir,
		env: () => ({
			PATH: process.env.PATH ?? "/usr/bin",
			HOME: root,
			CLAUDE_CONFIG_DIR: join(root, "shared-claude"),
			FAKE_CLAUDE_MODE: "login-auto",
			FAKE_CLAUDE_STATUS_MODE: "status-claudeai",
		}),
		store: () => store,
		executable: () => executable,
		connectionTest: async ({ model }) => ({ model, outcome: "ok", at: 0 }),
	};
}

export function cleanupFakeClaudeCliLogins(): void {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
