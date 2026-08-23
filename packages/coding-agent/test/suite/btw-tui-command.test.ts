import { describe, expect, it, vi } from "vitest";
import { BTW_SIDE_ENTRY_TYPE, type BtwSessionCatalog } from "../../src/core/extensions/builtin/btw/session-catalog.ts";
import {
	defaultBtwTuiCommandDependencies,
	type RunBtwTuiCommandDependencies,
	runBtwTuiCommand,
	serializeBtwParentContext,
} from "../../src/core/extensions/builtin/btw/tui-command.ts";
import type { ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function catalog(): BtwSessionCatalog {
	return {
		parentSessionPath: "/sessions/main.jsonl",
		main: {
			path: "/sessions/main.jsonl",
			cwd: "/repo",
			name: "Main",
			modified: new Date("2026-08-23T00:00:00.000Z"),
		},
		currentSide: undefined,
		sides: [
			{
				path: "/sessions/side-1.jsonl",
				cwd: "/repo",
				name: "BTW #1: first",
				modified: new Date("2026-08-23T00:00:01.000Z"),
				metadata: {
					version: 1,
					parentSessionPath: "/sessions/main.jsonl",
					parentSessionId: "main",
					ordinal: 1,
					summary: "first",
					createdAt: "2026-08-23T00:00:01.000Z",
				},
			},
		],
		skippedPaths: [],
	};
}

function createHarness(selections: Array<string | undefined> = []) {
	const select = vi.fn(async () => selections.shift());
	const notify = vi.fn();
	const waitForIdle = vi.fn(async () => undefined);
	const switchSession = vi.fn(async () => ({ cancelled: false }));
	const ctx = {
		cwd: "/repo",
		sessionManager: {
			getSessionFile: () => "/sessions/main.jsonl",
		},
		waitForIdle,
		switchSession,
		ui: {
			select,
			notify,
			getKeybindingKeys: () => ["ctrl+/", "ctrl+_", "ctrl+7"],
		},
	} as unknown as ExtensionCommandContext;
	const loaded = catalog();
	const dependencies: RunBtwTuiCommandDependencies = {
		loadCatalog: vi.fn(async () => loaded),
		createSide: vi.fn(async () => undefined),
		buildParentContext: vi.fn(async () => "bounded context"),
		sessionExists: vi.fn(async () => true),
	};
	return { ctx, dependencies, loaded, notify, select, switchSession, waitForIdle };
}

describe("runBtwTuiCommand", () => {
	it("refuses inline creation before Main has a persisted session path", async () => {
		// Given
		const harness = createHarness();
		vi.spyOn(harness.ctx.sessionManager, "getSessionFile").mockReturnValue(undefined);

		// When
		await runBtwTuiCommand("orphan question", harness.ctx, harness.dependencies);

		// Then
		expect(harness.notify).toHaveBeenCalledWith("BTW is unavailable until the current session is saved.", "warning");
		expect(harness.dependencies.createSide).not.toHaveBeenCalled();
		expect(harness.dependencies.loadCatalog).not.toHaveBeenCalled();
	});

	it("creates a fresh retained side directly for an inline question", async () => {
		// Given
		const harness = createHarness();

		// When
		await runBtwTuiCommand("next question", harness.ctx, harness.dependencies);

		// Then
		expect(harness.dependencies.createSide).toHaveBeenCalledWith(
			expect.objectContaining({
				ctx: harness.ctx,
				catalog: harness.loaded,
				question: "next question",
				parentContext: "bounded context",
			}),
		);
		expect(harness.waitForIdle).toHaveBeenCalledOnce();
		expect(harness.waitForIdle.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(harness.dependencies.buildParentContext).mock.invocationCallOrder[0]!,
		);
		expect(harness.select).not.toHaveBeenCalled();
	});

	it("opens the native picker and switches to the selected retained side", async () => {
		// Given
		const harness = createHarness(["BTW #1 — first"]);

		// When
		await runBtwTuiCommand("", harness.ctx, harness.dependencies);

		// Then
		expect(harness.select).toHaveBeenCalledWith(expect.stringContaining("Ctrl+7"), [
			"Main — Main",
			"BTW #1 — first",
			"New BTW",
		]);
		expect(harness.switchSession).toHaveBeenCalledWith("/sessions/side-1.jsonl");
	});

	it("creates an empty retained side when New BTW is selected", async () => {
		// Given
		const harness = createHarness(["New BTW"]);

		// When
		await runBtwTuiCommand("", harness.ctx, harness.dependencies);

		// Then
		expect(harness.dependencies.createSide).toHaveBeenCalledWith(
			expect.objectContaining({
				question: undefined,
				parentContext: "bounded context",
			}),
		);
		expect(harness.waitForIdle).toHaveBeenCalledOnce();
		expect(harness.dependencies.loadCatalog).toHaveBeenCalledTimes(2);
	});

	it("refreshes after a selected side disappears instead of switching stale state", async () => {
		// Given
		const harness = createHarness(["BTW #1 — first", "BTW #1 — first"]);
		vi.mocked(harness.dependencies.sessionExists).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		// When
		await runBtwTuiCommand("", harness.ctx, harness.dependencies);

		// Then
		expect(harness.dependencies.loadCatalog).toHaveBeenCalledTimes(2);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("no longer exists"), "warning");
		expect(harness.switchSession).toHaveBeenCalledOnce();
		expect(harness.switchSession).toHaveBeenCalledWith("/sessions/side-1.jsonl");
	});
});

describe("default BTW session discovery", () => {
	it("loads persisted sessions through typed command-context capabilities", async () => {
		// Given
		const loaded = catalog();
		const listSessions = vi.fn(async () => [loaded.main!, loaded.sides[0]!]);
		const inspectSession = vi.fn((sessionPath: string) => ({
			entries:
				sessionPath === loaded.sides[0]!.path
					? [
							{
								id: "side-metadata",
								parentId: null,
								timestamp: "2026-08-23T00:00:01.000Z",
								type: "custom" as const,
								customType: BTW_SIDE_ENTRY_TYPE,
								data: loaded.sides[0]!.metadata,
							},
						]
					: [],
			context: { messages: [] },
		}));
		const ctx = {
			cwd: "/repo",
			sessionManager: {
				getSessionDir: () => "/sessions",
				getSessionFile: () => loaded.parentSessionPath,
			},
			listSessions,
			inspectSession,
		} as unknown as ExtensionCommandContext;

		// When
		const discovered = await defaultBtwTuiCommandDependencies.loadCatalog(ctx);

		// Then
		expect(listSessions).toHaveBeenCalledOnce();
		expect(inspectSession).toHaveBeenCalled();
		expect(discovered.sides).toHaveLength(1);
	});
});

describe("serializeBtwParentContext", () => {
	it("uses Main's active leaf when Main is the visible session", async () => {
		// Given
		const loaded = catalog();
		const ctx = {
			sessionManager: {
				getSessionFile: () => loaded.parentSessionPath,
				getEntries: () => [],
				buildSessionContext: () => ({
					messages: [{ role: "user", content: [{ type: "text", text: "active leaf" }] }],
				}),
			},
		} as unknown as ExtensionCommandContext;

		// When
		const snapshot = await defaultBtwTuiCommandDependencies.buildParentContext(ctx, loaded);

		// Then
		expect(snapshot).toContain("active leaf");
	});

	it("reuses the persisted Main leaf when creating from a retained side", async () => {
		// Given
		const parent = SessionManager.inMemory("/repo");
		const selectedUser = parent.appendMessage(userMsg("selected branch"));
		const selectedLeaf = parent.appendMessage(assistantMsg("selected answer"));
		parent.branch(selectedUser);
		parent.appendMessage(userMsg("abandoned branch"));
		const loaded = catalog();
		loaded.currentSide = loaded.sides[0];
		loaded.currentSide!.metadata.parentLeafId = selectedLeaf;
		const inspectSession = vi.fn((_sessionPath: string, options?: { leafId?: string | null }) => {
			const entries = parent.getEntries();
			return {
				entries,
				context:
					options?.leafId === undefined
						? parent.buildSessionContext()
						: buildSessionContext(entries, options.leafId),
			};
		});
		const ctx = {
			sessionManager: {
				getSessionFile: () => loaded.currentSide!.path,
			},
			inspectSession,
		} as unknown as ExtensionCommandContext;

		// When
		const snapshot = await defaultBtwTuiCommandDependencies.buildParentContext(ctx, loaded);

		// Then
		expect(snapshot).toContain("selected branch");
		expect(snapshot).toContain("selected answer");
		expect(snapshot).not.toContain("abandoned branch");
		expect(inspectSession).toHaveBeenCalledWith(loaded.parentSessionPath, { leafId: selectedLeaf });
	});

	it("truncates an oversized newest message instead of dropping all context", () => {
		// Given
		const messages = [{ role: "user", content: `newest-${"x".repeat(70_000)}` }];

		// When
		const snapshot = serializeBtwParentContext(messages);

		// Then
		expect(snapshot).toContain("newest-");
		expect(snapshot.length).toBeLessThanOrEqual(64_000);
	});

	it("keeps the newest complete messages inside the bounded snapshot", () => {
		// Given
		const messages = [
			{ role: "user", content: `oldest-${"x".repeat(70_000)}` },
			{ role: "assistant", content: "newest answer" },
		];

		// When
		const snapshot = serializeBtwParentContext(messages);

		// Then
		expect(snapshot.length).toBeLessThanOrEqual(64_000);
		expect(snapshot).toContain("newest answer");
		expect(snapshot).not.toContain("oldest-");
	});
});
