import { describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";

const CHECKPOINT_CUSTOM_TYPE = "compaction.agent-checkpoint";
const TODO_SNAPSHOT_CUSTOM_TYPE = "compaction.todo-snapshot";

interface AppendCall {
	customType: string;
	data: unknown;
}

interface CompactionExtensionHarness {
	appendCalls: AppendCall[];
	beforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
	sessionCompact: ExtensionHandler<SessionCompactEvent>;
}

function createCompactionExtensionHarness(): CompactionExtensionHarness {
	let beforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> | undefined;
	let sessionCompact: ExtensionHandler<SessionCompactEvent> | undefined;
	const appendCalls: AppendCall[] = [];
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: ExtensionHandler<SessionBeforeCompactEvent | SessionCompactEvent, unknown>) => {
			if (event === "session_before_compact") {
				beforeCompact = handler as ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
			}
			if (event === "session_compact") {
				sessionCompact = handler as ExtensionHandler<SessionCompactEvent>;
			}
		},
		appendEntry: <T = unknown>(customType: string, data?: T) => {
			appendCalls.push({ customType, data });
		},
		getActiveTools: () => ["read", "write"],
		getThinkingLevel: () => "high" as const,
		events: {
			emit: vi.fn(),
		},
		sendMessage: vi.fn(),
	}) as ExtensionAPI;

	compactionExtension(api);
	if (!beforeCompact || !sessionCompact) {
		throw new Error("Compaction extension did not register expected handlers");
	}
	return { appendCalls, beforeCompact, sessionCompact };
}

function createExtensionContext(entries: SessionEntry[]): ExtensionContext {
	const sessionManager = {
		getEntries: () => entries,
		getBranch: () => entries,
	} as ExtensionContext["sessionManager"];

	return {
		hasUI: false,
		mode: "print",
		ui: Object.assign(Object.create(null), {
			notify: vi.fn(),
		}) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		beginCompaction: () => undefined,
		endCompaction: vi.fn(),
		getSystemPrompt: () => "",
	} as ExtensionContext;
}

function createPreparation(firstKeptEntryId: string): CompactionPreparation {
	return {
		firstKeptEntryId,
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createBeforeCompactEvent(requestId: string, firstKeptEntryId: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "overflow",
		willRetry: true,
		requestId,
		preparation: createPreparation(firstKeptEntryId),
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

function createCompactionEntry(id: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId: firstKeptEntryId,
		timestamp: new Date().toISOString(),
		summary: "Recovered compacted context",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

describe("compaction metadata side effects", () => {
	describe("Given a compaction request that has not been accepted yet", () => {
		describe("When session_before_compact runs", () => {
			it("Then checkpoint and todo metadata are not persisted until session_compact succeeds", async () => {
				const keptEntry: SessionEntry = {
					type: "message",
					id: "kept-user",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "continue", timestamp: Date.now() },
				};
				const harness = createCompactionExtensionHarness();
				const ctx = createExtensionContext([keptEntry]);
				const requestId = "overflow-request-1";

				await harness.beforeCompact(createBeforeCompactEvent(requestId, keptEntry.id), ctx);

				expect(harness.appendCalls).toEqual([]);

				await harness.sessionCompact(
					{
						type: "session_compact",
						reason: "overflow",
						requestId,
						accepted: true,
						compactionEntry: createCompactionEntry("compact-1", keptEntry.id),
						fromExtension: true,
						willRetry: true,
					},
					ctx,
				);

				expect(harness.appendCalls.map((call) => call.customType)).toEqual([
					CHECKPOINT_CUSTOM_TYPE,
					TODO_SNAPSHOT_CUSTOM_TYPE,
				]);
			});
		});
	});
});
