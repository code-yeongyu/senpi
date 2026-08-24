import { describe, expect, it, vi } from "vitest";
import {
	closeRetainedBtwSide,
	readCurrentBtwSide,
	returnToBtwParent,
} from "../../src/core/extensions/builtin/btw/session-actions.ts";
import { BTW_SIDE_ENTRY_TYPE, type BtwSideMetadata } from "../../src/core/extensions/builtin/btw/session-catalog.ts";
import type { ExtensionCommandContext, ReplacedSessionContext } from "../../src/core/extensions/types.ts";
import type { SessionEntry, SessionManager } from "../../src/core/session-manager.ts";

const SIDE_PATH = "/sessions/side-2.jsonl";
const PARENT_PATH = "/sessions/main.jsonl";

function sideMetadata(): BtwSideMetadata {
	return {
		version: 1,
		parentSessionPath: PARENT_PATH,
		parentSessionId: "main",
		parentLeafId: "main-leaf",
		ordinal: 2,
		summary: "second question",
		createdAt: "2026-08-23T00:00:02.000Z",
	};
}

function sideEntries(): SessionEntry[] {
	return [
		{
			type: "custom",
			id: "side-metadata",
			parentId: null,
			timestamp: "2026-08-23T00:00:02.000Z",
			customType: BTW_SIDE_ENTRY_TYPE,
			data: sideMetadata(),
		} as SessionEntry,
	];
}

function manager(entries = sideEntries()): SessionManager {
	return {
		getSessionId: () => "side",
		getLeafId: () => "side-leaf",
		getSessionDir: () => "/configured/sessions",
		getSessionFile: () => SIDE_PATH,
		getEntries: () => entries,
	} as unknown as SessionManager;
}

function createContext(options: { runWithSession?: boolean; parentSessionId?: string; sideSessionId?: string } = {}) {
	const notify = vi.fn();
	const navigateTree = vi.fn(async () => ({ cancelled: false }));
	const inspectSession = vi.fn((sessionPath: string) => ({
		id: sessionPath === SIDE_PATH ? (options.sideSessionId ?? "side") : (options.parentSessionId ?? "main"),
		entries: [],
		context: { messages: [] },
	}));
	const inspectSessionMetadata = vi.fn((sessionPath: string) => ({
		id: sessionPath === SIDE_PATH ? (options.sideSessionId ?? "side") : (options.parentSessionId ?? "main"),
		path: sessionPath,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
	}));
	const switchSession = vi.fn(
		async (
			_path: string,
			switchOptions?: {
				expectedSessionId?: string;
				withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			},
		) => {
			if (options.runWithSession !== false) {
				await switchOptions?.withSession?.({
					inspectSession,
					inspectSessionMetadata,
					navigateTree,
					ui: { notify },
				} as unknown as ReplacedSessionContext);
			}
			return { cancelled: options.runWithSession === false };
		},
	);
	return {
		ctx: {
			sessionManager: manager(),
			inspectSession,
			inspectSessionMetadata,
			switchSession,
			ui: { notify },
		} as unknown as ExtensionCommandContext,
		notify,
		navigateTree,
		inspectSession,
		inspectSessionMetadata,
		switchSession,
	};
}

describe("retained BTW session actions", () => {
	it("switches to Main and then deletes only the previously visible side", async () => {
		// Given
		const harness = createContext();
		const deleteSessionFile = vi.fn(async () => ({ ok: true as const, method: "unlink" as const }));

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
			deleteSessionFile,
		});

		// Then
		expect(harness.switchSession).toHaveBeenCalledWith(
			PARENT_PATH,
			expect.objectContaining({
				expectedSessionId: "main",
				expectedSource: { sessionId: "side", leafId: "side-leaf" },
				sessionDir: "/configured/sessions",
				withSession: expect.any(Function),
			}),
		);
		expect(deleteSessionFile).toHaveBeenCalledOnce();
		expect(deleteSessionFile).toHaveBeenCalledWith(SIDE_PATH);
		expect(harness.navigateTree).toHaveBeenCalledWith("main-leaf", { summarize: false });
		expect(harness.inspectSession).not.toHaveBeenCalled();
		expect(harness.inspectSessionMetadata).toHaveBeenCalledWith(PARENT_PATH);
		expect(harness.inspectSessionMetadata).toHaveBeenCalledWith(SIDE_PATH);
	});

	it("does not return to a reused parent path with a different session ID", async () => {
		// Given
		const harness = createContext({ parentSessionId: "replacement-main" });

		// When
		await returnToBtwParent({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
		});

		// Then
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("returns to Main without deleting the retained side", async () => {
		// Given
		const harness = createContext();
		const deleteSessionFile = vi.fn();

		// When
		await returnToBtwParent({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
		});

		// Then
		expect(harness.switchSession).toHaveBeenCalledWith(
			PARENT_PATH,
			expect.objectContaining({
				expectedSessionId: "main",
				expectedSource: { sessionId: "side", leafId: "side-leaf" },
				withSession: expect.any(Function),
			}),
		);
		expect(harness.navigateTree).toHaveBeenCalledWith("main-leaf", { summarize: false });
		expect(deleteSessionFile).not.toHaveBeenCalled();
	});

	it("does not delete a replacement side that reused the visible side path", async () => {
		// Given
		const harness = createContext({ sideSessionId: "replacement-side" });
		const deleteSessionFile = vi.fn();

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
			deleteSessionFile,
		});

		// Then
		expect(harness.switchSession).toHaveBeenCalledOnce();
		expect(deleteSessionFile).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledOnce();
		expect(harness.navigateTree).toHaveBeenCalledWith("main-leaf", { summarize: false });
	});

	it("re-adopts side metadata after a fresh session-manager reload", () => {
		// Given
		const reloadedManager = manager(structuredClone(sideEntries()));

		// When
		const current = readCurrentBtwSide(reloadedManager);

		// Then
		expect(current).toEqual({
			sessionId: "side",
			sourceLeafId: "side-leaf",
			sessionDir: "/configured/sessions",
			sessionPath: SIDE_PATH,
			metadata: sideMetadata(),
		});
	});

	it("keeps the side discoverable when the parent switch is cancelled", async () => {
		// Given
		const harness = createContext({ runWithSession: false });
		const deleteSessionFile = vi.fn();

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
			deleteSessionFile,
		});

		// Then
		expect(deleteSessionFile).not.toHaveBeenCalled();
	});

	it("reports deletion failure after switching and leaves the side file intact", async () => {
		// Given
		const harness = createContext();
		const deleteSessionFile = vi.fn(async () => ({
			ok: false as const,
			method: "unlink" as const,
			error: "permission denied",
		}));

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
			deleteSessionFile,
		});

		// Then
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("permission denied"), "warning");
		expect(harness.navigateTree).toHaveBeenCalledWith("main-leaf", { summarize: false });
	});

	it("does not delete the side when the parent path belongs to another session ID", async () => {
		// Given
		const harness = createContext({ parentSessionId: "replacement-main" });
		const deleteSessionFile = vi.fn();

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: readCurrentBtwSide(harness.ctx.sessionManager),
			deleteSessionFile,
		});

		// Then
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(deleteSessionFile).not.toHaveBeenCalled();
	});

	it("refuses destructive close when the current side has no parent path", async () => {
		// Given
		const harness = createContext();
		const deleteSessionFile = vi.fn();

		// When
		await closeRetainedBtwSide({
			ctx: harness.ctx,
			current: undefined,
			deleteSessionFile,
		});

		// Then
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(deleteSessionFile).not.toHaveBeenCalled();
	});
});
