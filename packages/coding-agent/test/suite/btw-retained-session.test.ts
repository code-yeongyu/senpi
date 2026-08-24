import { describe, expect, it, vi } from "vitest";
import {
	applyBtwSideSessionPolicy,
	type CreateRetainedBtwSideInput,
	createRetainedBtwSide,
	nextBtwOrdinal,
	summarizeBtwQuestion,
} from "../../src/core/extensions/builtin/btw/retained-session.ts";
import { BTW_SIDE_ENTRY_TYPE, type BtwSessionCatalog } from "../../src/core/extensions/builtin/btw/session-catalog.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ReplacedSessionContext,
} from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";

function catalog(sideCount = 0, currentSideOrdinal?: number): BtwSessionCatalog {
	const sides = Array.from({ length: sideCount }, (_, index) => ({
		id: `side-${index + 1}`,
		path: `/sessions/side-${index + 1}.jsonl`,
		cwd: "/repo",
		name: `BTW #${index + 1}: previous ${index + 1}`,
		modified: new Date(`2026-08-23T00:00:0${index + 1}.000Z`),
		metadata: {
			version: 1 as const,
			parentSessionPath: "/sessions/main.jsonl",
			parentSessionId: "main",
			ordinal: index + 1,
			summary: `previous ${index + 1}`,
			createdAt: `2026-08-23T00:00:0${index + 1}.000Z`,
		},
	}));
	return {
		parentSessionPath: "/sessions/main.jsonl",
		main: {
			id: "main",
			path: "/sessions/main.jsonl",
			cwd: "/repo",
			name: "Main",
			modified: new Date("2026-08-23T00:00:00.000Z"),
		},
		currentSide:
			currentSideOrdinal === undefined
				? undefined
				: sides.find((side) => side.metadata.ordinal === currentSideOrdinal),
		sides,
		skippedPaths: [],
	};
}

function createHarness() {
	const setups: Array<(manager: SessionManager) => Promise<void> | void> = [];
	const withSessions: Array<(ctx: ReplacedSessionContext) => Promise<void> | void> = [];
	const replacementActions: string[] = [];
	const setActiveTools = vi.fn(() => replacementActions.push("tools"));
	const setSessionModel = vi.fn(async () => {
		replacementActions.push("model");
		return true;
	});
	const setSessionThinkingLevel = vi.fn(() => replacementActions.push("thinking"));
	const sendUserMessage = vi.fn(async (_content: string) => undefined);
	const notify = vi.fn();
	const hasConfiguredAuth = vi.fn(() => true);
	const checkAuth = vi.fn(async () => true);
	const getLeafId = vi.fn(() => "main-active-leaf");
	const isIdle = vi.fn(() => true);
	const inspectSessionMetadata = vi.fn((sessionPath: string) => ({
		id: "main",
		path: sessionPath,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
	}));
	const newSession = vi.fn(async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
		if (options?.setup) setups.push(options.setup);
		if (options?.withSession) withSessions.push(options.withSession);
		return { cancelled: false };
	});
	const ctx = {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => "main",
			getLeafId,
			getEntries: () => [],
		},
		model: { provider: "faux", id: "faux-2" },
		modelRegistry: { checkAuth, hasConfiguredAuth },
		thinkingLevel: "high",
		getSourceActivityGeneration: () => 1,
		isIdle,
		ui: { notify },
		inspectSessionMetadata,
		newSession,
		waitForIdle: vi.fn(async () => undefined),
	} as unknown as ExtensionCommandContext;
	const manager = {
		appendCustomEntry: vi.fn(),
		appendCustomMessageEntry: vi.fn(),
		appendSessionInfo: vi.fn(),
		appendModelChange: vi.fn(),
		appendThinkingLevelChange: vi.fn(),
	} as unknown as SessionManager;
	const nextCtx = {
		sendUserMessage: async (content: string) => {
			replacementActions.push("send");
			await sendUserMessage(content);
		},
		setActiveTools,
		setSessionModel,
		setSessionThinkingLevel,
		ui: { notify },
	} as unknown as ReplacedSessionContext;
	return {
		ctx,
		manager,
		newSession,
		nextCtx,
		notify,
		checkAuth,
		hasConfiguredAuth,
		getLeafId,
		inspectSessionMetadata,
		isIdle,
		replacementActions,
		sendUserMessage,
		setActiveTools,
		setSessionModel,
		setSessionThinkingLevel,
		setups,
		withSessions,
	};
}

async function executeReplacement(harness: ReturnType<typeof createHarness>, call: number): Promise<void> {
	await harness.setups[call]?.(harness.manager);
	await harness.withSessions[call]?.(harness.nextCtx);
}

describe("createRetainedBtwSide", () => {
	it("uses max ordinal plus one and normalizes summaries for stable titles", () => {
		// Given
		const loaded = catalog(2);
		loaded.sides[0]!.metadata.ordinal = 7;
		const question = `  explain\nthis\tvery long topic ${"x".repeat(100)}`;

		// When
		const ordinal = nextBtwOrdinal(loaded);
		const summary = summarizeBtwQuestion(question);

		// Then
		expect(ordinal).toBe(8);
		expect(summary).toBe(`explain this very long topic ${"x".repeat(42)}…`);
	});

	it("creates a distinct numbered host session for every inline question", async () => {
		// Given
		const harness = createHarness();
		const base: Omit<CreateRetainedBtwSideInput, "catalog" | "question" | "now"> = {
			ctx: harness.ctx,
			buildParentContext: async () => "bounded parent context",
		};

		// When
		await createRetainedBtwSide({
			...base,
			catalog: catalog(0),
			question: "first question",
			now: () => new Date("2026-08-23T00:00:01.000Z"),
		});
		await createRetainedBtwSide({
			...base,
			catalog: catalog(1),
			question: "second question",
			now: () => new Date("2026-08-23T00:00:02.000Z"),
		});
		await executeReplacement(harness, 0);
		await executeReplacement(harness, 1);

		// Then
		expect(harness.newSession).toHaveBeenCalledTimes(2);
		expect(harness.newSession.mock.calls.map(([options]) => options?.parentSession)).toEqual([
			"/sessions/main.jsonl",
			"/sessions/main.jsonl",
		]);
		expect(harness.newSession.mock.calls.map(([options]) => options?.expectedParentSessionId)).toEqual([
			"main",
			"main",
		]);
		expect(harness.newSession.mock.calls.map(([options]) => options?.expectedSource)).toEqual([
			{ sessionId: "main", leafId: "main-active-leaf", wasIdle: true, activityGeneration: 1 },
			{ sessionId: "main", leafId: "main-active-leaf", wasIdle: true, activityGeneration: 1 },
		]);
		expect(harness.newSession.mock.calls.map(([options]) => options?.sessionToolPolicy)).toEqual([
			{ version: 1, tools: "disabled" },
			{ version: 1, tools: "disabled" },
		]);
		expect(harness.newSession.mock.calls.map(([options]) => options?.persistInitializedSession)).toEqual([
			true,
			true,
		]);
		const customEntryCalls = (harness.manager.appendCustomEntry as ReturnType<typeof vi.fn>).mock.calls;
		expect(
			customEntryCalls
				.filter(([customType]) => customType === BTW_SIDE_ENTRY_TYPE)
				.map(([, value]) => value.ordinal),
		).toEqual([1, 2]);
		expect(
			customEntryCalls
				.filter(([customType]) => customType === BTW_SIDE_ENTRY_TYPE)
				.map(([, value]) => value.parentLeafId),
		).toEqual(["main-active-leaf", "main-active-leaf"]);
		expect(harness.sendUserMessage.mock.calls.map(([question]) => question)).toEqual([
			"first question",
			"second question",
		]);
		expect(harness.replacementActions.slice(0, 4)).toEqual(["tools", "model", "thinking", "send"]);
		const contextCalls = (harness.manager.appendCustomMessageEntry as ReturnType<typeof vi.fn>).mock.calls;
		expect(contextCalls).toHaveLength(2);
		expect(contextCalls[0]?.[1]).toContain("bounded parent context");
		expect(contextCalls[0]?.[2]).toBe(false);
	});

	it("builds the parent snapshot after the final idle wait", async () => {
		// Given
		const harness = createHarness();
		const buildParentContext = vi.fn(async () => {
			expect(harness.ctx.waitForIdle).toHaveBeenCalledOnce();
			return "latest parent context";
		});

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: undefined,
			buildParentContext,
		});
		await executeReplacement(harness, 0);

		// Then
		expect(buildParentContext).toHaveBeenCalledOnce();
		expect(harness.manager.appendCustomMessageEntry).toHaveBeenCalledWith(
			"btw-parent-context",
			expect.stringContaining("latest parent context"),
			false,
			expect.any(Object),
		);
	});

	it("applies captured runtime state even when a new side has no inline question", async () => {
		// Given
		const harness = createHarness();

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: undefined,
			buildParentContext: async () => "bounded parent context",
		});
		await executeReplacement(harness, 0);

		// Then
		expect(harness.replacementActions).toEqual(["tools", "model", "thinking"]);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main when the captured model has no configured auth", async () => {
		// Given
		const harness = createHarness();
		harness.hasConfiguredAuth.mockReturnValue(false);

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not orphan",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main when the live provider auth check fails", async () => {
		// Given
		const harness = createHarness();
		harness.checkAuth.mockResolvedValue(false);

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not orphan",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.hasConfiguredAuth).toHaveBeenCalledOnce();
		expect(harness.checkAuth).toHaveBeenCalledOnce();
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main when its identity changes after auth succeeds", async () => {
		// Given
		const harness = createHarness();
		harness.checkAuth.mockImplementation(async () => {
			harness.inspectSessionMetadata.mockReturnValue({
				id: "replacement-main",
				path: "/sessions/main.jsonl",
				cwd: "/repo",
				created: new Date(0),
				modified: new Date(0),
			});
			return true;
		});

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not orphan",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.checkAuth).toHaveBeenCalledOnce();
		expect(harness.inspectSessionMetadata).toHaveBeenCalledWith("/sessions/main.jsonl");
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main when a newer turn is active after auth succeeds", async () => {
		// Given
		const harness = createHarness();
		harness.checkAuth.mockImplementation(async () => {
			harness.isIdle.mockReturnValue(false);
			return true;
		});

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not abort a newer turn",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main when a newer turn completes during auth", async () => {
		// Given
		const harness = createHarness();
		harness.checkAuth.mockImplementation(async () => {
			harness.getLeafId.mockReturnValue("newer-main-leaf");
			return true;
		});

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not use a stale snapshot",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does not replace Main for an inline question without an active model", async () => {
		// Given
		const harness = createHarness();
		harness.ctx.model = undefined;

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: catalog(0),
			question: "must not orphan",
			buildParentContext: async () => "bounded parent context",
		});

		// Then
		expect(harness.newSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("creates a sibling under the root parent when invoked from an existing side", async () => {
		// Given
		const harness = createHarness();
		const loaded = catalog(2, 2);
		loaded.currentSide!.metadata.parentLeafId = "persisted-main-leaf";

		// When
		await createRetainedBtwSide({
			ctx: harness.ctx,
			catalog: loaded,
			question: "third from side",
			buildParentContext: async () => "root parent context",
			now: () => new Date("2026-08-23T00:00:03.000Z"),
		});
		await executeReplacement(harness, 0);

		// Then
		expect(harness.newSession.mock.calls[0]?.[0]?.parentSession).toBe("/sessions/main.jsonl");
		expect(harness.manager.appendCustomEntry).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				parentSessionPath: "/sessions/main.jsonl",
				parentLeafId: "persisted-main-leaf",
				ordinal: 3,
				summary: "third from side",
			}),
		);
	});
});

describe("applyBtwSideSessionPolicy", () => {
	it("disables tools only when the loaded session has retained BTW metadata", () => {
		// Given
		const setActiveTools = vi.fn();
		const pi = { setActiveTools } as unknown as ExtensionAPI;
		const side = {
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: BTW_SIDE_ENTRY_TYPE,
						data: catalog(1).sides[0]!.metadata,
					},
				],
			},
		} as unknown as ExtensionContext;
		const main = {
			sessionManager: { getEntries: () => [] },
		} as unknown as ExtensionContext;

		// When
		const sideApplied = applyBtwSideSessionPolicy(pi, side);
		const mainApplied = applyBtwSideSessionPolicy(pi, main);

		// Then
		expect(sideApplied).toBe(true);
		expect(mainApplied).toBe(false);
		expect(setActiveTools).toHaveBeenCalledOnce();
		expect(setActiveTools).toHaveBeenCalledWith([]);
	});
});
