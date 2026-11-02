/**
 * senpi#4436: every entry point that removes an Anthropic Subscription `claude-cli` account takes the same removal,
 * so they cannot diverge again: `/claude-account remove`, RPC `account_remove`, and a provider `/logout` (which drops
 * every account). Each signs the account out of the CLI by its account dir, never follows a linked dir, and removes
 * the account even when the sign-out cannot run, with a notice.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { removeCredentialAccount } from "../../../src/core/credential-accounts.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import {
	type AnthropicSubscriptionCredential,
	type ClaudeCliAccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	accountDirFor,
	ensureAccountDir,
} from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

const PROVIDER = "anthropic-subscription";
const DIR_ID = "c".repeat(32);
const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "claude-cli-auth", "fake-claude.mjs");
const SLOT: ClaudeCliAccountSlot = { name: "work", source: "login", store: "claude-cli", dirId: DIR_ID };

type EntryPoint = {
	open(agentDir: string): Promise<{ storage: AuthStorage; remove: () => Promise<string | undefined>; close(): void }>;
};

const claudeAccountRemove: EntryPoint = {
	async open(agentDir) {
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		let command: Pick<RegisteredCommand, "handler"> | undefined;
		const pi = {
			registerCommand: (name: string, registered: Pick<RegisteredCommand, "handler">) => {
				if (name === "claude-account") command = registered;
			},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: () => {},
		} as unknown as ExtensionAPI;
		registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
		const notices: { message: string; type: string | undefined }[] = [];
		const ctx = {
			hasUI: true,
			cwd: agentDir,
			sessionManager: { getSessionId: () => "session-4436" },
			modelRegistry: { authStorage: storage },
			ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		} as unknown as ExtensionCommandContext;
		return {
			storage,
			remove: async () => {
				await command?.handler("remove work", ctx);
				const last = notices.at(-1);
				if (last?.type === "error") throw new Error(last.message);
				return last?.type === "warning" ? last.message : undefined;
			},
			close: () => {},
		};
	},
};

const rpcAccountRemove: EntryPoint = {
	async open(agentDir) {
		const harness = makeHarness(agentDir);
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		return {
			storage: harness.authStorage,
			remove: async () => {
				await handler.handleInputLine(
					JSON.stringify({ id: "remove", type: "account_remove", provider: PROVIDER, name: "work" }),
				);
				const response = await collected.waitFor((message) => message.id === "remove");
				if (response.success !== true) throw new Error(String(response.error));
				return (response.data as { notice?: string } | undefined)?.notice;
			},
			close: () => {
				void handler.dispose();
				harness.cleanup();
			},
		};
	},
};

const rpcLogout: EntryPoint = {
	async open(agentDir) {
		const harness = makeHarness(agentDir);
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		return {
			storage: harness.authStorage,
			remove: async () => {
				await handler.handleInputLine(JSON.stringify({ id: "logout", type: "logout", provider: PROVIDER }));
				const response = await collected.waitFor((message) => message.id === "logout");
				if (response.success !== true) throw new Error(String(response.error));
				return (response.data as { notices?: string[] } | undefined)?.notices?.[0];
			},
			close: () => {
				void handler.dispose();
				harness.cleanup();
			},
		};
	},
};

const providerLogout: EntryPoint = {
	async open(agentDir) {
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
		return {
			storage,
			remove: async () => (await runtime.logoutProvider(PROVIDER)).notices[0],
			close: () => {},
		};
	},
};

type Scenario = {
	mode: string;
	prepare(accountDir: string, sharedRoot: string): void;
	notice: RegExp | undefined;
	signedOut: boolean;
	linkKept: boolean;
};

const SCENARIOS: Record<string, Scenario> = {
	"signs out by path and removes the dir": {
		mode: "logout-ok",
		prepare: () => {},
		notice: undefined,
		signedOut: true,
		linkKept: false,
	},
	"removes the account and dir when the sign-out fails, with a notice": {
		mode: "logout-fail",
		prepare: () => {},
		notice: /sign-out could not run/,
		signedOut: true,
		linkKept: false,
	},
	"never follows a linked account dir, and still removes the account with a notice": {
		mode: "logout-ok",
		prepare: (accountDir, sharedRoot) => {
			rmSync(accountDir, { recursive: true, force: true });
			symlinkSync(sharedRoot, accountDir, process.platform === "win32" ? "junction" : "dir");
		},
		notice: /link or a file, left untouched/,
		signedOut: false,
		linkKept: true,
	},
};

const ENTRY_POINTS: Record<string, EntryPoint> = {
	"/claude-account remove": claudeAccountRemove,
	"RPC account_remove": rpcAccountRemove,
	"provider /logout": providerLogout,
	"RPC logout": rpcLogout,
};

const roots: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
	for (const close of closers.splice(0)) close();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("senpi#4436 every claude-cli account removal entry point takes the same path", () => {
	const rows = Object.entries(ENTRY_POINTS).flatMap(([entry, entryPoint]) =>
		Object.entries(SCENARIOS).map(([scenario, expected]) => [entry, scenario, entryPoint, expected] as const),
	);

	it.each(rows)("%s %s", async (_entry, _scenario, entryPoint, expected) => {
		const root = mkdtempSync(join(tmpdir(), "senpi-4436-removal-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const sharedRoot = join(root, "shared-claude");
		mkdirSync(agentDir);
		mkdirSync(join(sharedRoot, "projects"), { recursive: true });
		writeFileSync(join(sharedRoot, "projects", "x.jsonl"), "{}\n");
		const executable = join(root, "claude");
		copyFileSync(FIXTURE, executable);
		chmodSync(executable, 0o755);
		const record = join(root, "record.jsonl");
		vi.stubEnv("CLAUDE_CODE_EXECUTABLE", executable);
		vi.stubEnv("CLAUDE_CONFIG_DIR", sharedRoot);
		vi.stubEnv("FAKE_CLAUDE_MODE", expected.mode);
		vi.stubEnv("FAKE_CLAUDE_RECORD", record);
		const opened = await entryPoint.open(agentDir);
		closers.push(opened.close);
		await opened.storage.modify(PROVIDER, async () => ({ ...emptyCredential(), accounts: [SLOT] }));
		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });
		expect(accountDir).toBe(accountDirFor(agentDir, DIR_ID));
		expected.prepare(accountDir, sharedRoot);

		const notice = await opened.remove();

		if (expected.notice === undefined) expect(notice).toBeUndefined();
		else expect(notice).toMatch(expected.notice);
		const logouts = existsSync(record)
			? readFileSync(record, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { argv: string[]; configDir: string })
			: [];
		expect(logouts).toEqual(
			expected.signedOut ? [expect.objectContaining({ argv: ["auth", "logout"], configDir: accountDir })] : [],
		);
		if (expected.linkKept) expect(lstatSync(accountDir).isSymbolicLink()).toBe(true);
		else expect(existsSync(accountDir)).toBe(false);
		expect(readFileSync(join(sharedRoot, "projects", "x.jsonl"), "utf8")).toBe("{}\n");
		const stored = (await opened.storage.read(PROVIDER)) as AnthropicSubscriptionCredential | undefined;
		expect((stored?.accounts ?? []).map((slot) => slot.name)).toEqual([]);
	});
});

describe("senpi#4436 a provider logout of several claude-cli accounts", () => {
	async function logoutLane(mode: string, names: readonly string[]) {
		const root = mkdtempSync(join(tmpdir(), "senpi-4436-logout-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const sharedRoot = join(root, "shared-claude");
		mkdirSync(agentDir);
		mkdirSync(join(sharedRoot, "projects"), { recursive: true });
		const executable = join(root, "claude");
		copyFileSync(FIXTURE, executable);
		chmodSync(executable, 0o755);
		const record = join(root, "record.jsonl");
		vi.stubEnv("CLAUDE_CODE_EXECUTABLE", executable);
		vi.stubEnv("CLAUDE_CONFIG_DIR", sharedRoot);
		vi.stubEnv("FAKE_CLAUDE_MODE", mode);
		vi.stubEnv("FAKE_CLAUDE_RECORD", record);
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const slots = names.map((name, index) => ({ ...SLOT, name, dirId: String(index + 1).repeat(32) }));
		await storage.modify(PROVIDER, async () => ({ ...emptyCredential(), accounts: slots }));
		const dirs = slots.map((slot) => ensureAccountDir({ agentDir, dirId: slot.dirId, sharedRoot }));
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
		const storedNames = async () =>
			(((await storage.read(PROVIDER)) as AnthropicSubscriptionCredential | undefined)?.accounts ?? []).map(
				(slot) => slot.name,
			);
		return { root, record, storage, dirs, runtime, storedNames };
	}

	it("drops each account as it is signed out, so a failure on a later one leaves no earlier one stored without its dir", async () => {
		const lane = await logoutLane("logout-ok", ["first", "second"]);
		// The second account's dir cannot be removed: a read-only subdir holds a file.
		const locked = join(lane.dirs[1] ?? "", "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "keep"), "x");
		chmodSync(locked, 0o500);
		closers.push(() => chmodSync(locked, 0o700));

		await expect(lane.runtime.logoutProvider(PROVIDER)).rejects.toThrow();

		expect(existsSync(lane.dirs[0] ?? "")).toBe(false);
		expect(existsSync(lane.dirs[1] ?? "")).toBe(true);
		expect(await lane.storedNames()).toEqual(["second"]);
	});

	it("a drop that fails after the dir was removed keeps the slot, and the next removal drops it", async () => {
		const lane = await logoutLane("logout-ok", ["work", "keep"]);
		const drop = vi.spyOn(lane.storage, "modify").mockRejectedValueOnce(new Error("store busy"));

		await expect(removeCredentialAccount(lane.storage, PROVIDER, "work")).rejects.toThrow("store busy");
		expect(existsSync(lane.dirs[0] ?? "")).toBe(false);
		expect(await lane.storedNames()).toEqual(["work", "keep"]);

		drop.mockRestore();
		await removeCredentialAccount(lane.storage, PROVIDER, "work");
		expect(await lane.storedNames()).toEqual(["keep"]);
		expect(existsSync(lane.dirs[0] ?? "")).toBe(false);
		expect(existsSync(lane.dirs[1] ?? "")).toBe(true);
	});

	it("honors the caller's abort signal while a Claude CLI sign-out hangs, deleting nothing", async () => {
		const lane = await logoutLane("logout-hang", ["only"]);
		const controller = new AbortController();
		const started = new Promise<void>((resolve) => {
			const watcher = watch(lane.root, (_event, file) => {
				if (file === "record.jsonl") {
					watcher.close();
					resolve();
				}
			});
			closers.push(() => watcher.close());
		});

		const logout = lane.runtime.logoutProvider(PROVIDER, { signal: controller.signal });
		await started;
		controller.abort();

		await expect(logout).rejects.toThrow();
		expect(existsSync(lane.dirs[0] ?? "")).toBe(true);
		expect(await lane.storedNames()).toEqual(["only"]);
	});
});
