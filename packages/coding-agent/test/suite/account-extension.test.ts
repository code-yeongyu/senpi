import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import accountExtension from "../../src/core/extensions/builtin/account/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/core/extensions/types.ts";

type Command = Pick<RegisteredCommand, "handler">;
type Notice = { message: string; type: "info" | "warning" | "error" | undefined };

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "account-extension-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function registeredCommand(): Command {
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
	} as unknown as ExtensionAPI;
	accountExtension(pi);
	const registered = commands.get("account");
	if (!registered) throw new Error("/account was not registered");
	return registered;
}

function createContext(): { ctx: ExtensionCommandContext; notices: Notice[] } {
	const notices: Notice[] = [];
	return {
		ctx: {
			hasUI: true,
			cwd: dir,
			signal: undefined,
			sessionManager: { getSessionId: () => "session-01" },
			modelRegistry: { authStorage: storage },
			ui: {
				notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
			},
		} as unknown as ExtensionCommandContext,
		notices,
	};
}

async function seedPool(provider: string): Promise<void> {
	await storage.modify(provider, async () => ({
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	}));
}

describe("/account command", () => {
	it("lists accounts for any provider without leaking key material", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();

		await registeredCommand().handler("openai", ctx);

		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("Credential accounts for openai:");
		expect(output).toContain("default | login | available");
		expect(output).toContain("work | login | available");
		expect(output).not.toContain("key-default");
		expect(output).not.toContain("key-work");
	});

	it("pins, reflects the pin in list output, and unpins", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();
		const command = registeredCommand();

		await command.handler("openai pin work", ctx);
		await command.handler("openai list", ctx);
		expect(notices.map((notice) => notice.message).join("\n")).toContain("work | login | available | pinned");

		await command.handler("openai unpin", ctx);
		await command.handler("openai list", ctx);
		expect(notices.at(-1)?.message).not.toContain("pinned");
	});

	it("removes one account and keeps its sibling", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();
		const command = registeredCommand();

		await command.handler("openai remove work", ctx);
		await command.handler("openai list", ctx);

		const output = notices.at(-1)?.message ?? "";
		expect(output).toContain("default");
		expect(output).not.toContain("work");
	});

	it("reports errors as notifications instead of crashing", async () => {
		await seedPool("openai");
		const { ctx, notices } = createContext();

		await registeredCommand().handler("openai pin missing", ctx);

		expect(notices.at(-1)).toEqual({ message: "Provider account not found: missing", type: "error" });
	});

	it("shows usage without a provider argument", async () => {
		const { ctx, notices } = createContext();

		await registeredCommand().handler("", ctx);

		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("Usage: /account");
	});
});
