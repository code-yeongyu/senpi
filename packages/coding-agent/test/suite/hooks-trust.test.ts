import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildHookTrustRecord,
	createHookTrustEntry,
	filterExecutableTrustedHooks,
	hookTrustId,
	hookTrustStorageScope,
	isCommandHookTrusted,
	listHookTrustRecords,
	readHookTrustStateJson,
} from "../../src/core/extensions/builtin/hooks/trust.ts";
import {
	FileHookStateStorage,
	InMemoryHookStateStorage,
} from "../../src/core/extensions/builtin/hooks/trust-storage.ts";
import type { ExecutableHookHandler, HookSourceMetadata } from "../../src/core/extensions/builtin/hooks/types.ts";

const PROJECT_SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 1,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

const UPDATED_AT = "2026-06-29T00:00:00.000Z";
const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks trust", () => {
	it("builds stable hook ids and canonical command hashes", () => {
		// Given
		const hook = commandHook({ groupIndex: 2, handlerIndex: 3 });
		const reorderedEquivalent = {
			source: PROJECT_SOURCE,
			matcher: "Bash",
			handlerIndex: 3,
			groupIndex: 2,
			event: "PreToolUse",
			config: {
				statusMessage: "Checking tool call",
				timeout: 30,
				commandWindows: "node hooks/check.ps1",
				command: "node hooks/check.mjs",
				type: "command",
			},
		} satisfies ExecutableHookHandler;

		// When
		const record = buildHookTrustRecord(hook, { platform: "linux" });
		const equivalentRecord = buildHookTrustRecord(reorderedEquivalent, { platform: "linux" });

		// Then
		expect(record.id).toBe("hk_f426e074193a_PreToolUse_2_3");
		expect(hookTrustId(hook)).toBe(record.id);
		expect(record.currentHash).toBe("sha256:83901748237ea5ed4ec8741e50e7fc233770daf0e7f804f4300013ffa44d0406");
		expect(equivalentRecord).toEqual(record);
		expect(record.commandPreview).toBe("node hooks/check.mjs");
	});

	it("invalidates trust when command identity fields change", () => {
		// Given
		const hook = commandHook();
		const trusted = {
			version: 1,
			hooks: {
				[hookTrustId(hook)]: createHookTrustEntry(hook, { platform: "linux", updatedAt: UPDATED_AT }),
			},
		} as const;

		// When
		const commandChanged = commandHook({ command: "node hooks/changed.mjs" });
		const commandWindowsChanged = commandHook({ commandWindows: "node hooks/changed.ps1" });
		const timeoutChanged = commandHook({ timeout: 31 });
		const statusMessageChanged = commandHook({ statusMessage: "Different status" });

		// Then
		expect(isCommandHookTrusted(hook, trusted, { platform: "linux" })).toBe(true);
		expect(isCommandHookTrusted(commandChanged, trusted, { platform: "linux" })).toBe(false);
		expect(isCommandHookTrusted(commandWindowsChanged, trusted, { platform: "linux" })).toBe(false);
		expect(isCommandHookTrusted(timeoutChanged, trusted, { platform: "linux" })).toBe(false);
		expect(isCommandHookTrusted(statusMessageChanged, trusted, { platform: "linux" })).toBe(false);
	});

	it("lists disabled and untrusted hooks while skipping execution", () => {
		// Given
		const trustedHook = commandHook({ groupIndex: 0, handlerIndex: 0 });
		const disabledHook = commandHook({ groupIndex: 0, handlerIndex: 1 });
		const untrustedHook = commandHook({ groupIndex: 0, handlerIndex: 2 });
		const state = {
			version: 1,
			hooks: {
				[hookTrustId(trustedHook)]: createHookTrustEntry(trustedHook, {
					platform: "linux",
					updatedAt: UPDATED_AT,
				}),
				[hookTrustId(disabledHook)]: {
					...createHookTrustEntry(disabledHook, { platform: "linux", updatedAt: UPDATED_AT }),
					enabled: false,
				},
			},
		} as const;

		// When
		const records = listHookTrustRecords([trustedHook, disabledHook, untrustedHook], state, { platform: "linux" });
		const executable = filterExecutableTrustedHooks([trustedHook, disabledHook, untrustedHook], state, {
			platform: "linux",
		});

		// Then
		expect(
			records.map((record) => ({ enabled: record.enabled, executable: record.executable, trusted: record.trusted })),
		).toEqual([
			{ enabled: true, executable: true, trusted: true },
			{ enabled: false, executable: false, trusted: true },
			{ enabled: true, executable: false, trusted: false },
		]);
		expect(executable).toEqual([trustedHook]);
	});

	it("keeps malformed or stale state untrusted", () => {
		// Given
		const hook = commandHook();

		// When
		const malformed = readHookTrustStateJson("{ bad json");
		const stale = readHookTrustStateJson(JSON.stringify({ version: 0, hooks: { [hookTrustId(hook)]: {} } }));

		// Then
		expect(isCommandHookTrusted(hook, malformed, { platform: "linux" })).toBe(false);
		expect(isCommandHookTrusted(hook, stale, { platform: "linux" })).toBe(false);
	});

	it("persists state through storage without trusting project hooks by default", async () => {
		// Given
		const hook = commandHook();
		const storage = new InMemoryHookStateStorage();
		const globalHook = commandHook({
			source: { ...PROJECT_SOURCE, scope: "global", sourcePath: "/home/user/hooks.json" },
		});

		// When
		const initial = storage.read("global");
		storage.update("global", (current) => ({
			version: 1,
			hooks: {
				...current.hooks,
				[hookTrustId(globalHook)]: createHookTrustEntry(globalHook, { updatedAt: UPDATED_AT }),
			},
		}));
		const persisted = storage.read("global");

		// Then
		expect(initial).toEqual({ version: 1, hooks: {} });
		expect(hookTrustStorageScope(hook, { projectTrusted: false })).toBeUndefined();
		expect(hookTrustStorageScope(hook, { projectTrusted: true })).toBe("project");
		expect(hookTrustStorageScope(globalHook, { projectTrusted: false })).toBe("global");
		expect(isCommandHookTrusted(hook, persisted)).toBe(false);
		expect(isCommandHookTrusted(globalHook, persisted)).toBe(true);
	});

	it("uses a bounded proper-lockfile-compatible file lock for writes", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		mkdirSync(dirname(join(agentDir, "hooks-state.json")), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const statePath = join(agentDir, "hooks-state.json");
		const release = lockfile.lockSync(dirname(statePath), { realpath: false, lockfilePath: `${statePath}.lock` });

		try {
			expect(() => storage.update("global", (current) => current)).toThrow();
		} finally {
			release();
		}

		// When
		storage.update("global", (current) => ({
			version: 1,
			hooks: {
				...current.hooks,
				[hookTrustId(commandHook())]: createHookTrustEntry(commandHook(), { updatedAt: UPDATED_AT }),
			},
		}));

		// Then
		expect(await readFile(statePath, "utf-8")).toContain('"version": 1');
	});
});

function commandHook(
	overrides: {
		readonly command?: string;
		readonly commandWindows?: string;
		readonly timeout?: number;
		readonly statusMessage?: string;
		readonly groupIndex?: number;
		readonly handlerIndex?: number;
		readonly source?: HookSourceMetadata;
	} = {},
): ExecutableHookHandler {
	return {
		event: "PreToolUse",
		matcher: "Bash",
		groupIndex: overrides.groupIndex ?? 0,
		handlerIndex: overrides.handlerIndex ?? 0,
		config: {
			type: "command",
			command: overrides.command ?? "node hooks/check.mjs",
			commandWindows: overrides.commandWindows ?? "node hooks/check.ps1",
			timeout: overrides.timeout ?? 30,
			statusMessage: overrides.statusMessage ?? "Checking tool call",
		},
		source: overrides.source ?? PROJECT_SOURCE,
	};
}
