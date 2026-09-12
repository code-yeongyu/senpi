import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import gptAccountExtension from "../../src/core/extensions/builtin/gpt-account.ts";
import { type Command, createAccountCommandContext, registerCommand } from "./account-command-harness.ts";

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpt-account-extension-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function registeredGptCommand(): Command {
	return registerCommand("gpt-account", gptAccountExtension);
}

function createContext() {
	return createAccountCommandContext(storage, dir);
}

async function seedCodexPool(): Promise<void> {
	await storage.modify("openai-codex", async () => ({
		type: "oauth",
		access: "access-secret",
		refresh: "refresh-secret",
		expires: 1,
		accounts: [
			{ name: "default", access: "access-secret", refresh: "refresh-secret", expires: 1, source: "login" },
			{ name: "work", access: "work-access", refresh: "work-refresh", expires: 1, source: "login" },
		],
	}));
}

describe("/gpt-account command", () => {
	it("lists OpenAI Codex OAuth accounts without leaking tokens", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("", ctx);

		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("OpenAI Codex OAuth accounts:");
		expect(output).toContain("default | login | available");
		expect(output).toContain("work | login | available");
		expect(output).not.toContain("access-secret");
		expect(output).not.toContain("work-access");
	});

	it("pins and unpins an OpenAI Codex OAuth account", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();
		const command = registeredGptCommand();

		await command.handler("pin work", ctx);
		await command.handler("", ctx);
		expect(notices[notices.length - 1]?.message).toContain("work | login | available | pinned");

		await command.handler("unpin", ctx);
		expect(storage.get("openai-codex")).not.toHaveProperty("pinned");
	});

	it("remove deletes exactly the named account", async () => {
		await seedCodexPool();
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove work", ctx);

		expect(notices.at(-1)?.message).toContain("Removed OpenAI Codex OAuth account 'work'");
		expect(storage.listSlots("openai-codex").map((slot) => slot.name)).toEqual(["default"]);
	});

	it("remove default on a promoted pool leaves the survivor as the stored top-level credential", async () => {
		// The shape appendLoginSlot writes when a legacy flat openai-codex credential
		// gains a second login: the flat fields still project the legacy `default`.
		await storage.modify("openai-codex", async () => ({
			type: "oauth",
			access: "legacy-access",
			refresh: "legacy-refresh",
			expires: 1,
			accounts: [
				{ name: "default", access: "legacy-access", refresh: "legacy-refresh", expires: 1, source: "login" },
				{ name: "login-2", access: "second-access", refresh: "second-refresh", expires: 2, source: "login" },
			],
		}));
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove default", ctx);

		expect(notices.at(-1)?.message).toContain("Removed OpenAI Codex OAuth account 'default'");
		expect(storage.listSlots("openai-codex").map((slot) => slot.name)).toEqual(["login-2"]);
		expect(storage.get("openai-codex")).toMatchObject({
			type: "oauth",
			access: "second-access",
			refresh: "second-refresh",
			expires: 2,
		});
	});

	it("remove without a name reports usage instead of removing anything", async () => {
		const { ctx, notices } = createContext();

		await registeredGptCommand().handler("remove", ctx);

		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("Usage: /gpt-account");
	});
});
