import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { formatAccountRetryTime } from "../../../src/core/credential-account-status.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { type Command, createAccountCommandContext, registerCommand } from "../account-command-harness.ts";

// oh-my-openagent#9234: the account lists show each account's limit windows (used share, reset time, data age).
const FIVE_HOUR_RESET = Date.now() + 2 * 3_600_000;
const WEEK_RESET = Date.now() + 3 * 86_400_000;

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omo-9234-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function recordWindows(provider: string, account: string): void {
	subscriptionLimits.record(provider, account, [
		{ id: "w:5h", label: "5h", usedPercent: 72.4, resetsAt: new Date(FIVE_HOUR_RESET).toISOString() },
		{ id: "w:7d", label: "7d", usedPercent: 31, resetsAt: new Date(WEEK_RESET).toISOString() },
	]);
}

const EXPECTED_LIMITS = `    limits: 5h 72% used, resets ${formatAccountRetryTime(FIVE_HOUR_RESET)}; 7d 31% used, resets ${formatAccountRetryTime(WEEK_RESET)} (updated just now)`;

async function listOutput(command: Command): Promise<string> {
	const { ctx, notices } = createAccountCommandContext(storage, dir);
	await command.handler("", ctx);
	return notices.map((notice) => notice.message).join("\n");
}

function slot(name: string) {
	return {
		name,
		source: "login" as const,
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: 9_999_999_999_999,
	};
}

describe("account lists show each account's limit windows (oh-my-openagent#9234)", () => {
	it("/gpt-account", async () => {
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			...slot("gpt-9234-reported"),
			accounts: [slot("gpt-9234-reported"), slot("gpt-9234-silent")],
		}));
		recordWindows("chatgpt-subscription", "gpt-9234-reported");

		const lines = (await listOutput(registerCommand("gpt-account", gptAccountExtension))).split("\n");

		const reported = lines.findIndex((line) => line.includes("gpt-9234-reported | login"));
		expect(lines[reported + 1]).toBe(EXPECTED_LIMITS);
		const silent = lines.findIndex((line) => line.includes("gpt-9234-silent | login"));
		expect(lines[silent + 1]).toBe("    limits: not reported yet");
	});

	it("an account whose first usage check failed shows why instead of 'not reported yet'", async () => {
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			...slot("gpt-9234-failed"),
			accounts: [slot("gpt-9234-failed")],
		}));
		subscriptionLimits.report("chatgpt-subscription", "gpt-9234-failed", {
			error: "sign-in needed",
			reportedAt: new Date(),
		});

		const lines = (await listOutput(registerCommand("gpt-account", gptAccountExtension))).split("\n");

		const failed = lines.findIndex((line) => line.includes("gpt-9234-failed | login"));
		expect(lines[failed + 1]).toBe("    limits: last check failed: sign-in needed");
	});

	it("/claude-account", async () => {
		const credential = [slot("claude-9234-reported"), slot("claude-9234-silent")].reduce(
			(current, account) => addAccount(current, account),
			emptyCredential(),
		);
		await storage.modify("anthropic-subscription", async () => credential);
		recordWindows("anthropic-subscription", "claude-9234-reported");
		const commands = new Map<string, Command>();
		const pi = {
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			registerFlag: () => undefined,
			getFlag: () => undefined,
			on: () => undefined,
		} as unknown as ExtensionAPI;
		registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
		const command = commands.get("claude-account");
		if (!command) throw new Error("/claude-account was not registered");

		const lines = (await listOutput(command)).split("\n");

		const reported = lines.findIndex((line) => line.includes("claude-9234-reported | login"));
		expect(lines[reported + 1]).toBe(EXPECTED_LIMITS);
		const silent = lines.findIndex((line) => line.includes("claude-9234-silent | login"));
		expect(lines[silent + 1]).toBe("    limits: not reported yet");
	});
});
