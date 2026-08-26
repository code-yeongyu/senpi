import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLoopExtension,
	createNodeTimerPort,
	LOOP_TICK_ENTRY_TYPE,
	type LoopController,
	type LoopExtensionDeps,
	type LoopTickEntryData,
	renderLoopTickEntry,
} from "../../src/core/extensions/builtin/loop/index.ts";
import type { LoopTimerPort } from "../../src/core/extensions/builtin/loop/scheduler.ts";
import { loopStateFilePath, writeLoopState } from "../../src/core/extensions/builtin/loop/store.ts";
import type { LoopState, LoopStoreRef } from "../../src/core/extensions/builtin/loop/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

/**
 * Lets a sync timer callback's async dispatch chain finish before assertions run. The chain
 * resolves the loop file and builds the tick message before sending, so poll for the observable
 * instead of guessing a fixed number of turns.
 */
async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
	// Deadline-based rather than iteration-counted: 200 event-loop turns proved too few on a
	// loaded CI shard worker (the dispatch chain includes real fs reads), while a broken chain
	// still fails fast because the predicate only flips on the observable dispatch itself.
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`settleUntil timed out waiting for: ${label}`);
}
const SESSION_ID = "loop-extension-session";
/** Stable across fixtures so a resumed fingerprint compares equal to the persisted one. */
const LOOP_FILE_PATH = "/workspace/.senpi/loop.md";

initTheme("dark");

/** Fake timer port: records armed keys and lets the test fire them explicitly. */
class FakeTimers implements LoopTimerPort {
	readonly armed = new Map<string, { dueAt: number; callback: () => void }>();
	readonly armLog: Array<{ key: string; dueAt: number }> = [];
	cancelAllCount = 0;

	arm(key: string, dueAt: number, callback: () => void): void {
		this.armed.set(key, { dueAt, callback });
		this.armLog.push({ key, dueAt });
	}

	cancel(key: string): void {
		this.armed.delete(key);
	}

	cancelAll(): void {
		this.cancelAllCount += 1;
		this.armed.clear();
	}

	get armedKeys(): string[] {
		return [...this.armed.keys()];
	}

	fire(key: string): void {
		const entry = this.armed.get(key);
		if (entry === undefined) throw new Error(`no timer armed for ${key}`);
		entry.callback();
	}
}

interface SentUserMessage {
	readonly text: string;
	readonly deliverAs: "steer" | "followUp" | undefined;
	readonly expandPromptTemplates: boolean | undefined;
}

interface SentCustomMessage {
	readonly customType: string;
	readonly details: unknown;
	readonly deliverAs: "steer" | "followUp" | "nextTurn" | undefined;
	readonly triggerTurn: boolean | undefined;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Fixture {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly timers: FakeTimers;
	readonly controller: LoopController;
	readonly userMessages: SentUserMessage[];
	readonly customMessages: SentCustomMessage[];
	readonly entries: Array<{ customType: string; data: unknown }>;
	readonly notices: Array<{ message: string; type: string | undefined }>;
	readonly statuses: Array<string | undefined>;
	readonly sessionNames: string[];
	readonly storeRef: LoopStoreRef;
	setNow(value: number): void;
	advance(ms: number): void;
	now(): number;
	setIdle(idle: boolean): void;
	setPending(pending: boolean): void;
	setContextEntries(entries: Array<{ customType: string; data?: unknown }>): void;
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	persisted(): Promise<LoopState | undefined>;
}

const tempDirs: string[] = [];

async function fixture(
	options: {
		now?: number;
		deps?: Partial<LoopExtensionDeps>;
		initialState?: LoopState;
		corruptStore?: string;
		loopFileContent?: string;
	} = {},
): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-loop-ext-"));
	tempDirs.push(dir);
	const storeRef: LoopStoreRef = { baseDir: join(dir, "extensions", "loop"), sessionId: SESSION_ID };

	let current = options.now ?? T0;
	let idle = true;
	let pending = false;
	let contextEntries: Array<{ customType: string; data?: unknown }> = [];
	const timers = new FakeTimers();
	const userMessages: SentUserMessage[] = [];
	const customMessages: SentCustomMessage[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notices: Array<{ message: string; type: string | undefined }> = [];
	const statuses: Array<string | undefined> = [];
	const sessionNames: string[] = [];
	const handlers = new Map<string, Handler[]>();

	let loopSeq = 0;
	let wakeupSeq = 0;
	let deliverySeq = 0;

	if (options.initialState !== undefined) {
		await writeLoopState(storeRef, options.initialState);
	}
	if (options.corruptStore !== undefined) {
		const path = loopStateFilePath(storeRef);
		await writeFile(path.replace(/[^/]+$/, ".keep"), "", "utf8").catch(() => {});
		await writeLoopState(storeRef, emptyState(current));
		await writeFile(path, options.corruptStore, "utf8");
	}

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendUserMessage: (
			content: string,
			opts?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		) => {
			userMessages.push({
				text: content,
				deliverAs: opts?.deliverAs,
				expandPromptTemplates: opts?.expandPromptTemplates,
			});
			// The real session emits an `input` event for every prompt, including the ones an
			// extension sends, so the harness does too: attribution must survive its own tick.
			void emit("input", { text: content, source: "extension", inputId: `extension-${userMessages.length}` });
		},
		sendMessage: (
			message: { customType: string; details?: unknown },
			opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		) => {
			customMessages.push({
				customType: message.customType,
				details: message.details,
				deliverAs: opts?.deliverAs,
				triggerTurn: opts?.triggerTurn,
			});
		},
		setSessionName: (name: string) => sessionNames.push(name),
		getSessionName: () => sessionNames[sessionNames.length - 1],
		getCommands: () => [{ name: "loop" }],
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		agentDir: join(dir, "agent"),
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		},
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionDir: () => join(dir, "sessions"),
			getSessionFile: () => join(dir, "sessions", "session.jsonl"),
			// `appendEntry` produces `type: "custom"` entries carrying `data`, so the harness
			// mirrors that shape rather than a hand-rolled one.
			buildContextEntries: () => contextEntries.map((entry) => ({ type: "custom", ...entry })),
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;

	let controller: LoopController | undefined;
	const deps: LoopExtensionDeps = {
		clock: { now: () => current },
		timers: () => timers,
		ids: {
			loopId: () => `loop-${++loopSeq}`,
			wakeupId: () => `wakeup-${++wakeupSeq}`,
			deliveryId: () => `delivery-${++deliverySeq}`,
		},
		storeRef: () => storeRef,
		resolveLoopFile: async () =>
			options.loopFileContent === undefined
				? { found: false }
				: {
						found: true,
						path: LOOP_FILE_PATH,
						content: options.loopFileContent,
						fingerprint: {
							path: LOOP_FILE_PATH,
							mtimeMs: 1000,
							size: options.loopFileContent.length,
							contentHash: `hash-${options.loopFileContent.length}`,
						},
					},
		onControllerReady: (next) => {
			controller = next;
		},
		...options.deps,
	};

	await createLoopExtension(deps)(pi);
	if (controller === undefined) throw new Error("loop extension did not publish a controller");

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(event) ?? []) {
			await handler({ type: event, ...payload }, ctx);
		}
	}

	return {
		pi,
		ctx,
		timers,
		controller,
		userMessages,
		customMessages,
		entries,
		notices,
		statuses,
		sessionNames,
		storeRef,
		setNow: (value) => {
			current = value;
		},
		advance: (ms) => {
			current += ms;
		},
		now: () => current,
		setIdle: (value) => {
			idle = value;
		},
		setPending: (value) => {
			pending = value;
		},
		setContextEntries: (next) => {
			contextEntries = next;
		},
		emit,
		persisted: async () => {
			const { readLoopState } = await import("../../src/core/extensions/builtin/loop/store.ts");
			return (await readLoopState(storeRef)) ?? undefined;
		},
	};
}

/**
 * Ends the iteration a tick started, the way a real turn does: the model reschedules the
 * dynamic loop and the turn settles, so the next fire is not coalesced away.
 */
async function settleTurn(f: Fixture, loopId: string): Promise<void> {
	await f.controller.scheduleWakeup({
		loopId,
		requestedDelaySeconds: 1200,
		delaySeconds: 1200,
		reason: "keep going",
		prompt: "/loop",
		noop: false,
	});
	await f.emit("agent_end", { messages: [] });
	await f.emit("agent_settled");
}

function emptyState(now: number): LoopState {
	return { version: 1, sessionId: SESSION_ID, entries: {}, activeDynamicId: null, updatedAt: now };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

describe("loop extension tick dispatch", () => {
	it("dispatches an idle fixed tick through the real command path", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });

		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);

		expect(f.userMessages).toHaveLength(1);
		expect(f.userMessages[0].expandPromptTemplates).toBe(true);
		expect(f.userMessages[0].deliverAs).toBeUndefined();
		expect(f.userMessages[0].text).toContain("ping");

		const persisted = await f.persisted();
		expect(persisted).toBeDefined();
		expect(Object.keys(persisted?.entries ?? {})).toHaveLength(1);
		expect(f.timers.armedKeys).toHaveLength(1);
	});

	it("delivers a due tick as a follow-up while streaming and never steers", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		// The immediate first tick runs and its turn completes.
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");
		f.userMessages.length = 0;

		// The user starts their own turn; the next occurrence comes due mid-stream.
		f.setIdle(false);
		await f.emit("input", { text: "user question", source: "interactive" });
		await f.emit("agent_start");
		f.advance(5 * MINUTE);
		await f.controller.fireDue(created.loopId);

		expect(f.userMessages).toHaveLength(1);
		expect(f.userMessages[0].deliverAs).toBe("followUp");
		expect(f.userMessages.some((message) => message.deliverAs === "steer")).toBe(false);
	});

	it("routes a timer-driven fire through persist-and-dispatch, not scheduler state alone", async () => {
		// Regression: every other due-tick test calls controller.fireDue() directly, but the real
		// runtime only ever invokes the armed timer callback. That callback discarded the dispatch
		// decision, so a recurring loop delivered its first tick and then silently never recurred.
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		// The immediate first tick runs and its turn completes.
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");
		f.userMessages.length = 0;
		const tickCountAfterFirst = (await f.persisted())?.entries[created.loopId]?.tickCount ?? 0;

		// Fire through the timer port exactly as the runtime does - never via fireDue().
		f.advance(5 * MINUTE);
		f.timers.fire(created.loopId);
		await settleUntil(() => f.userMessages.length > 0, "timer-driven tick dispatch");

		expect(f.userMessages).toHaveLength(1);
		expect(f.userMessages[0].text).toContain("ping");
		const persisted = await f.persisted();
		expect(persisted?.entries[created.loopId]?.tickCount ?? 0).toBeGreaterThan(tickCountAfterFirst);
		expect(f.timers.armedKeys).toEqual([created.loopId]);
	});

	it("attaches loop attribution details to every dispatched tick", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const tickEntries = f.entries.filter((entry) => entry.customType === LOOP_TICK_ENTRY_TYPE);
		expect(tickEntries).toHaveLength(1);
		const data = tickEntries[0].data as LoopTickEntryData;
		expect(data.loopId).toBe(created.loopId);
		expect(data.deliveryId).toBe("delivery-1");
		expect(data.scheduledForAt).toBe(T0);
		expect(data.mode).toBe("fixed");
		expect(data.delivery).toBe("prompt");
	});

	it("names the session after the loop when a loop is the first prompt", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		await f.controller.startFixed({
			originalArgs: "5m ping the deploy",
			prompt: "ping the deploy",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});

		expect(f.sessionNames).toEqual(["loop: ping the deploy"]);
	});
});

describe("loop extension lifecycle", () => {
	it("persists a suspended snapshot and leaves no timer armed after shutdown", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(f.timers.armedKeys).toHaveLength(1);

		await f.emit("session_shutdown", { reason: "quit" });

		expect(f.timers.armedKeys).toEqual([]);
		const persisted = await f.persisted();
		const entry = persisted?.entries[created.loopId];
		expect(entry?.phase).toBe("suspended");
		expect(entry?.endReason).toBeUndefined();
	});

	it("re-arms across shutdown and start with exactly one recovery tick for an overdue job", async () => {
		const first = await fixture();
		await first.emit("session_start", { reason: "startup" });
		const created = await first.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		await first.emit("session_shutdown", { reason: "quit" });
		const suspended = await first.persisted();
		expect(suspended).toBeDefined();
		if (suspended === undefined) return;

		// Three days later: many occurrences were missed while the machine slept.
		const resumed = await fixture({ now: T0 + 3 * 24 * 60 * MINUTE, initialState: suspended });
		await resumed.emit("session_start", { reason: "resume" });

		expect(resumed.userMessages).toHaveLength(1);
		expect(resumed.timers.armedKeys).toEqual([created.loopId]);
		const entry = (await resumed.persisted())?.entries[created.loopId];
		expect(entry?.kind).toBe("fixed");
		if (entry?.kind !== "fixed") return;
		expect(entry.nextFireAt).toBe(resumed.now() + 5 * MINUTE);
	});

	it("ends the loop with terminal reason error and notifies the user when the store is corrupt", async () => {
		const f = await fixture({ corruptStore: "{ not json" });
		await f.emit("session_start", { reason: "resume" });

		expect(f.notices.length).toBeGreaterThan(0);
		expect(f.notices.map((notice) => notice.message).join("\n")).toMatch(/loop/i);
		expect(f.notices.some((notice) => notice.type === "error")).toBe(true);
		expect(f.controller.lastStoreFailure()?.endReason).toBe("error");
		expect(f.timers.armedKeys).toEqual([]);
	});

	it("ends a live loop with terminal reason error when its state can no longer be persisted", async () => {
		let failWrites = false;
		const f = await fixture({
			deps: {
				writeState: async (ref, state) => {
					if (failWrites) throw new Error("simulated loop store corruption");
					await writeLoopState(ref, state);
				},
			},
		});
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		f.notices.length = 0;
		f.userMessages.length = 0;

		failWrites = true;
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");

		expect(f.controller.lastStoreFailure()?.endReason).toBe("error");
		expect(f.controller.lastStoreFailure()?.loopIds).toContain(created.loopId);
		expect(f.controller.isEndedWithError(created.loopId)).toBe(true);
		expect(f.notices.some((notice) => notice.type === "error")).toBe(true);
		expect(f.timers.armedKeys).toEqual([]);

		// A loop retired with `error` must not dispatch another tick.
		f.advance(5 * MINUTE);
		await f.controller.fireDue(created.loopId);
		expect(f.userMessages).toEqual([]);
	});

	it("pauses rather than ends the loop on a user abort", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		await f.emit("session_abort");

		const entry = (await f.persisted())?.entries[created.loopId];
		expect(entry?.phase).toBe("suspended");
		expect(entry?.endReason).toBeUndefined();
		expect(f.timers.armedKeys).toEqual([]);
		expect(f.notices.map((notice) => notice.message).join("\n")).toContain("/loop resume");
	});
});

describe("loop extension sentinel delivery", () => {
	it("forces a full sentinel tick after an accepted compaction", async () => {
		const f = await fixture({ loopFileContent: "do the tasks" });
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startBare({ originalArgs: "" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(f.userMessages).toHaveLength(1);
		expect(f.userMessages[0].text).toContain("do the tasks");
		await settleTurn(f, created.loopId);

		// Second tick with an unchanged file is a short reminder.
		f.advance(20 * MINUTE);
		await f.controller.fireDue(created.loopId);
		expect(f.userMessages).toHaveLength(2);
		expect(f.userMessages[1].text).not.toContain("do the tasks");
		await settleTurn(f, created.loopId);

		// Compaction must not touch timers or phase, only the delivery decision.
		const armedBefore = [...f.timers.armedKeys];
		const phaseBefore = (await f.persisted())?.entries[created.loopId]?.phase;
		await f.emit("session_compact", { accepted: true, reason: "manual", requestId: "r1" });
		expect(f.timers.armedKeys).toEqual(armedBefore);
		expect((await f.persisted())?.entries[created.loopId]?.phase).toBe(phaseBefore);

		f.advance(20 * MINUTE);
		await f.controller.fireDue(created.loopId);
		expect(f.userMessages).toHaveLength(3);
		expect(f.userMessages[2].text).toContain("do the tasks");
	});

	it("forces a full sentinel tick when the anchor is missing from the compaction-aware context on resume", async () => {
		const first = await fixture({ loopFileContent: "do the tasks" });
		await first.emit("session_start", { reason: "startup" });
		const created = await first.controller.startBare({ originalArgs: "" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		await first.emit("session_shutdown", { reason: "quit" });
		const suspended = await first.persisted();
		expect(suspended).toBeDefined();
		if (suspended === undefined) return;

		// Resume with an anchor still present: the next tick stays a reminder.
		const withAnchor = await fixture({ loopFileContent: "do the tasks", initialState: suspended });
		withAnchor.setContextEntries([
			{ customType: LOOP_TICK_ENTRY_TYPE, data: { loopId: created.loopId, deliveryId: "delivery-1" } },
		]);
		await withAnchor.emit("session_start", { reason: "resume" });
		await settleTurn(withAnchor, created.loopId);
		withAnchor.advance(20 * MINUTE);
		await withAnchor.controller.fireDue(created.loopId);
		const anchoredTick = withAnchor.userMessages[withAnchor.userMessages.length - 1];
		expect(anchoredTick.text).not.toContain("do the tasks");

		// Resume with the anchor gone: compaction dropped it, so the next tick is full again.
		const withoutAnchor = await fixture({ loopFileContent: "do the tasks", initialState: suspended });
		withoutAnchor.setContextEntries([]);
		await withoutAnchor.emit("session_start", { reason: "resume" });
		await settleTurn(withoutAnchor, created.loopId);
		withoutAnchor.advance(20 * MINUTE);
		await withoutAnchor.controller.fireDue(created.loopId);
		const unanchoredTick = withoutAnchor.userMessages[withoutAnchor.userMessages.length - 1];
		expect(unanchoredTick.text).toContain("do the tasks");
	});
});

describe("loop extension keepalive", () => {
	it("arms one keepalive on the first omission and ends the loop on the second", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startDynamic({ originalArgs: "watch the queue", prompt: "watch the queue" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		// First dynamic iteration ends without schedule_wakeup: one keepalive fallback.
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");
		let entry = (await f.persisted())?.entries[created.loopId];
		expect(entry?.kind).toBe("dynamic");
		if (entry?.kind !== "dynamic") return;
		expect(entry.keepaliveCredit).toBe(0);
		expect(entry.pendingWakeup?.source).toBe("keepalive");
		expect(f.timers.armedKeys).toEqual([created.loopId]);

		// The keepalive iteration also omits it: the loop ends.
		f.advance(entry.pendingWakeup === null ? MINUTE : entry.pendingWakeup.dueAt - f.now());
		await f.controller.fireDue(created.loopId);
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");

		entry = (await f.persisted())?.entries[created.loopId];
		expect(entry?.phase).toBe("ended");
		expect(entry?.endReason).toBe("keepalive_exhausted");
		expect(f.timers.armedKeys).toEqual([]);
	});

	it("never applies keepalive after an ordinary user turn", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startDynamic({ originalArgs: "watch the queue", prompt: "watch the queue" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		// Settle the loop's own first iteration by scheduling, so nothing is attributed.
		await f.controller.scheduleWakeup({
			loopId: created.loopId,
			requestedDelaySeconds: 600,
			delaySeconds: 600,
			reason: "poll later",
			prompt: "/loop watch the queue",
			noop: false,
		});

		// An ordinary user turn runs and ends: keepalive must not fire.
		await f.emit("input", { text: "unrelated user question", source: "interactive" });
		await f.emit("agent_end", { messages: [] });
		await f.emit("agent_settled");

		const entry = (await f.persisted())?.entries[created.loopId];
		expect(entry?.kind).toBe("dynamic");
		if (entry?.kind !== "dynamic") return;
		expect(entry.keepaliveCredit).toBe(1);
		expect(entry.pendingWakeup?.source).toBe("model");
		expect(entry.phase).toBe("waiting");
	});
});

describe("loop extension noop folding", () => {
	it("folds two consecutive noop ticks and resets the streak on a non-noop tick", async () => {
		const f = await fixture();
		await f.emit("session_start", { reason: "startup" });
		const created = await f.controller.startDynamic({ originalArgs: "watch the queue", prompt: "watch the queue" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		for (let index = 0; index < 2; index++) {
			await f.controller.scheduleWakeup({
				loopId: created.loopId,
				requestedDelaySeconds: 60,
				delaySeconds: 60,
				reason: "quiet",
				prompt: "/loop watch the queue",
				noop: true,
			});
			await f.emit("agent_settled");
			f.advance(60_000);
			await f.controller.fireDue(created.loopId);
		}

		const folded = f.entries
			.filter((entry) => entry.customType === LOOP_TICK_ENTRY_TYPE)
			.map((entry) => entry.data as LoopTickEntryData);
		const lastFolded = folded[folded.length - 1];
		expect(lastFolded.noopStreak).toBe(2);
		expect(lastFolded.folded).toBe(true);
		const rendered = renderLoopTickEntry(
			{
				type: "custom",
				id: "entry-folded",
				parentId: null,
				timestamp: "2026-08-18T00:00:00.000Z",
				customType: LOOP_TICK_ENTRY_TYPE,
				data: lastFolded,
			},
			{ expanded: false },
			theme,
		);
		expect(rendered?.render(80).join("\n")).toContain("2 loop ticks with no actionable change");

		// A non-noop schedule resets the streak, so the next tick renders unfolded.
		await f.controller.scheduleWakeup({
			loopId: created.loopId,
			requestedDelaySeconds: 60,
			delaySeconds: 60,
			reason: "found work",
			prompt: "/loop watch the queue",
			noop: false,
		});
		await f.emit("agent_settled");
		f.advance(60_000);
		await f.controller.fireDue(created.loopId);

		const after = f.entries
			.filter((entry) => entry.customType === LOOP_TICK_ENTRY_TYPE)
			.map((entry) => entry.data as LoopTickEntryData);
		const latest = after[after.length - 1];
		expect(latest.noopStreak).toBe(0);
		expect(latest.folded).toBe(false);
	});
});

describe("loop timer port", () => {
	it("runs the newest arm once and never runs a cancelled or superseded one", async () => {
		const port = createNodeTimerPort();
		const fired: string[] = [];
		const settled = new Promise<void>((resolve) => {
			port.arm("a", Date.now(), () => fired.push("stale-a"));
			port.arm("a", Date.now(), () => {
				fired.push("fresh-a");
				resolve();
			});
			port.arm("b", Date.now(), () => fired.push("cancelled-b"));
			port.cancel("b");
		});

		await settled;
		// A 0ms timeout armed AFTER the ones under test drains behind them in Node's timer
		// queue, so this observes absence deterministically rather than waiting on a delay.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(fired).toEqual(["fresh-a"]);
	});

	it("cancelAll clears every armed key", async () => {
		const port = createNodeTimerPort();
		const fired: string[] = [];
		port.arm("a", Date.now(), () => fired.push("a"));
		port.arm("b", Date.now(), () => fired.push("b"));
		port.cancelAll();

		// Same ordering guarantee: this timeout was armed last, so it drains last.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(fired).toEqual([]);
	});
});

describe("loop extension status line", () => {
	it("publishes the armed status line on session start and clears it on shutdown", async () => {
		const f = await fixture({ initialState: undefined });
		await f.emit("session_start", { reason: "startup" });
		await f.controller.startFixed({
			originalArgs: "5m ping",
			prompt: "ping",
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});

		expect(f.statuses.filter((text) => text !== undefined).some((text) => text?.includes("/loop stop"))).toBe(true);

		await f.emit("session_shutdown", { reason: "quit" });
		expect(f.statuses[f.statuses.length - 1]).toBeUndefined();
	});
});
