import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClientMessageIdConflictError,
	PendingInputDivergenceError,
	SessionPendingInputs,
} from "../../src/core/pending-input-session.ts";
import {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
} from "../../src/core/pending-input-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

// senpi#3549: AgentSession admits identified queued input into durable custody and delivers it through the port.

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runWithHeldTool() {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await held;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	harnesses.push(harness);
	const toolStarted = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	return { harness, release, toolStarted };
}

function phases(harness: Harness, clientMessageId: string): string[] {
	return harness.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION ? [entry.data] : [],
		)
		.filter((data): data is PendingInputJournalRecord => (data as PendingInputJournalRecord).input !== undefined)
		.filter((record) => record.input.clientMessageId === clientMessageId)
		.map((record) => record.input.phase);
}

describe("AgentSession pending inputs", () => {
	it("journals an identified steer as delivered before the request that carries it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		const phasesAtRequest: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			() => {
				phasesAtRequest.push(phases(harness, "c-1"));
				return fauxAssistantMessage("handled");
			},
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.steer("look here", undefined, { clientMessageId: "c-1" });
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "look here"]);
		expect(phasesAtRequest).toEqual([["queued", "sending", "delivered"]]);
	});

	it("queues a repeated identical submit once", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["once"]);
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "once"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "sending", "delivered"]);
	});

	it("refuses a reused client id with another payload and queues nothing for it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("first", undefined, { clientMessageId: "c-1" });

		await expect(harness.session.followUp("second", undefined, { clientMessageId: "c-1" })).rejects.toBeInstanceOf(
			ClientMessageIdConflictError,
		);
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "first"]);
	});

	it("delivers the edited text of an identified input and records the edit before it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("draft", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, "final", { expectedRevision: 1 });
		release();
		await run;

		expect(answer).toBe("edited");
		expect(getUserTexts(harness)).toEqual(["start", "final"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "queued", "sending", "delivered"]);
	});

	it("removes an identified input from its record and the queue, so it is never delivered", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("drop me", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, undefined);
		release();
		await run;

		expect(answer).toBe("removed");
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "removed"]);
	});

	it("answers conflict for a stale revision and changes neither the record nor the queue", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("v1", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";
		await harness.session.changeQueuedInput(queuedId, "v2", { expectedRevision: 1 });

		const answer = await harness.session.changeQueuedInput(queuedId, "stale", { expectedRevision: 1 });

		expect(answer).toBe("conflict");
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["v2"]);
		release();
		await run;
		expect(getUserTexts(harness)).toEqual(["start", "v2"]);
	});

	it("records a cleared identified input as removed, so it is neither delivered nor restored", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("drop on stop", undefined, { clientMessageId: "c-1" });

		const cleared = harness.session.clearQueue();
		await harness.session.whenQueueClearRecorded();
		release();
		await run;
		await harness.session.restoreQueuedInput({
			clientMessageId: "c-1",
			text: "drop on stop",
			mode: "followUp",
			enqueueOrder: 1,
		});

		expect(cleared.ordered.map((input) => input.text)).toEqual(["drop on stop"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "removed"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.session.getQueuedInputs()).toEqual([]);
	});

	it("edits an identified input held back after a compaction and delivers the edit once released (T26, T27)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("after follow-up")]);
		const internals = harness.session as unknown as {
			_promptStartPending: boolean;
			_skipNextPostCompactionAssistantCheck: boolean;
			_flushPostCompactionDeferredMessages(): void;
		};
		internals._promptStartPending = true;
		internals._skipNextPostCompactionAssistantCheck = true;
		await harness.session.followUp("held draft", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, "held final", { expectedRevision: 1 });
		internals._promptStartPending = false;
		internals._skipNextPostCompactionAssistantCheck = false;
		internals._flushPostCompactionDeferredMessages();
		await harness.session.prompt("go");

		expect(answer).toBe("edited");
		expect(getUserTexts(harness)).toEqual(["go", "held final"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "queued", "sending", "delivered"]);
	});

	it("keeps the legacy queue path (the TUI's until P2c) exactly as before: sync answers, no journal, no events", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const updates: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "pending_input_update") updates.push(event);
		});
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("one");
		await harness.session.followUp("two");
		await harness.session.steer("three");
		const [one, two] = harness.session.getQueuedInputs();

		const edited = harness.session.editQueuedInput(one?.queuedId ?? "", "one edited", { expectedRevision: 1 });
		const removed = harness.session.dequeueQueuedInput(two?.queuedId ?? "");
		const stale = harness.session.editQueuedInput(one?.queuedId ?? "", "late", { expectedRevision: 1 });
		const cleared = harness.session.clearQueue();
		await harness.session.whenQueueClearRecorded();
		release();
		await run;

		expect([edited, removed, stale]).toEqual(["edited", "removed", "conflict"]);
		expect(cleared).toEqual({ steering: ["three"], followUp: ["one edited"] });
		expect(cleared.ordered.map((input) => input.text)).toEqual(["one edited", "three"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(updates).toEqual([]);
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION),
		).toBe(false);
	});

	it("answers a delivered input explicitly instead of treating its absence from the queue as an outcome (T33)", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("sent", undefined, { clientMessageId: "c-1" });
		release();
		await run;

		const snapshot = await harness.session.getPendingInputs(["c-1", "unknown"]);

		expect(snapshot.inputs).toEqual([]);
		expect(snapshot.outcomes).toEqual([
			expect.objectContaining({
				clientMessageId: "c-1",
				status: "admitted",
				projection: expect.objectContaining({ state: "delivered" }),
			}),
			{ clientMessageId: "unknown", status: "not_admitted" },
		]);
	});

	it("queues an identified input sent after a Stop for the next turn (T34), and never restores a delivered one (T30)", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after stop"),
			fauxAssistantMessage("next turn"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("stopped", undefined, { clientMessageId: "c-1" });
		harness.session.clearQueue();
		await harness.session.whenQueueClearRecorded();
		await harness.session.followUp("after cutoff", undefined, { clientMessageId: "c-2" });
		release();
		await run;
		await harness.session.restoreQueuedInput({
			clientMessageId: "c-2",
			text: "after cutoff",
			mode: "followUp",
			enqueueOrder: 9,
		});

		expect(getUserTexts(harness)).toEqual(["start", "after cutoff"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "removed"]);
		expect(phases(harness, "c-2")).toEqual(["queued", "sending", "delivered"]);
		expect(harness.session.getQueuedInputs()).toEqual([]);
	});

	it("keeps input without a client id out of the journal", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("plain");
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "plain"]);
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION),
		).toBe(false);
	});
});

describe("SessionPendingInputs.change", () => {
	it("leaves the native queue alone when the record of the change cannot be saved", async () => {
		const records: PendingInputJournalRecord[] = [];
		let failNext = false;
		const journal: PendingInputJournal = {
			append: async (record) => {
				if (failNext) throw new Error("disk full");
				records.push(record);
			},
			read: async () => records,
		};
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: SessionManager.inMemory(),
			nextQueuedId: () => `q_${++queuedIds}`,
			journal,
		});
		await inputs.admit({ clientMessageId: "c-1", text: "draft", mode: "followUp" }, () => undefined);
		let nativeChanged = false;
		failNext = true;

		await expect(
			inputs.change({ clientMessageId: "c-1", text: "final" }, () => {
				nativeChanged = true;
				return "edited";
			}),
		).rejects.toThrow("disk full");
		expect(nativeChanged).toBe(false);
	});

	it("answers not_found when a clear emptied the queue while the edit was being saved, and the clear retires it", async () => {
		const records: PendingInputJournalRecord[] = [];
		let midAppend: (() => void) | undefined;
		const journal: PendingInputJournal = {
			append: async (record) => {
				records.push(record);
				const run = midAppend;
				midAppend = undefined;
				run?.();
			},
			read: async () => records,
		};
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: SessionManager.inMemory(),
			nextQueuedId: () => `q_${++queuedIds}`,
			journal,
		});
		await inputs.admit({ clientMessageId: "c-1", text: "draft", mode: "followUp" }, () => undefined);
		let nativeQueued = true;
		let cleared: Promise<void> | undefined;
		midAppend = () => {
			nativeQueued = false;
			cleared = inputs.recordCleared(["c-1"]);
		};

		const outcome = await inputs.change({ clientMessageId: "c-1", text: "final" }, () =>
			nativeQueued ? "edited" : "not_found",
		);
		await cleared;

		expect(outcome).toBe("not_found");
		expect(records.at(-1)?.input).toMatchObject({ clientMessageId: "c-1", phase: "removed" });
	});

	it("still refuses a missing native copy that no clear explains (review L-c)", async () => {
		const records: PendingInputJournalRecord[] = [];
		const journal: PendingInputJournal = {
			append: async (record) => {
				records.push(record);
			},
			read: async () => records,
		};
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: SessionManager.inMemory(),
			nextQueuedId: () => `q_${++queuedIds}`,
			journal,
		});
		await inputs.admit({ clientMessageId: "c-1", text: "draft", mode: "followUp" }, () => undefined);

		await expect(inputs.change({ clientMessageId: "c-1", text: "final" }, () => "not_found")).rejects.toBeInstanceOf(
			PendingInputDivergenceError,
		);
	});
});

describe("pending-input recovery on reopen", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function sessionDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pending-recovery-"));
		dirs.push(dir);
		return dir;
	}

	function inputsOver(sessionManager: SessionManager): SessionPendingInputs {
		let queuedIds = 100;
		return new SessionPendingInputs({ sessionManager, nextQueuedId: () => `q_${++queuedIds}` });
	}

	it("reports a failed eager open to the next caller, never as an unhandled rejection", async () => {
		const records: PendingInputJournalRecord[] = [];
		let failAppends = false;
		const journal: PendingInputJournal = {
			append: async (record) => {
				if (failAppends) throw new Error("disk gone");
				records.push(record);
			},
			read: async () => records,
		};
		const sessionManager = SessionManager.inMemory();
		const before = new SessionPendingInputs({ sessionManager, nextQueuedId: () => "q_1", journal });
		await before.admit({ clientMessageId: "c-1", text: "q", mode: "followUp" }, () => undefined);
		sessionManager.appendCustomEntry(PENDING_INPUT_TRANSITION, records[0]);
		failAppends = true;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const after = new SessionPendingInputs({ sessionManager, nextQueuedId: () => "q_2", journal });
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(unhandled).toEqual([]);
			await expect(after.snapshot()).rejects.toThrow("disk gone");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("recovers a queued input and an attempt cut off before delivery, and retires a delivered one", async () => {
		const dir = sessionDir();
		const first = SessionManager.create(dir, dir);
		const before = inputsOver(first);
		await before.admit({ clientMessageId: "queued", text: "q", mode: "followUp" }, () => undefined);
		await before.admit({ clientMessageId: "cut", text: "c", mode: "followUp" }, () => undefined);
		await before.admit({ clientMessageId: "done", text: "d", mode: "followUp" }, () => undefined);
		const port = before.queuedInputPort();
		const user = (clientMessageId: string) => ({
			role: "user" as const,
			content: "x",
			timestamp: 1,
			clientMessageId,
		});
		const cut = user("cut");
		const done = user("done");
		await port.claim("followUp", () => [cut, done]);
		await port.commitConsumption("followUp", [done]);

		const after = inputsOver(SessionManager.open(first.getSessionFile() ?? "", dir));

		expect(await after.restoreHandle("queued")).toEqual({ queuedId: expect.stringMatching(/^q_/) });
		expect(await after.restoreHandle("cut")).toEqual({ queuedId: expect.stringMatching(/^q_/) });
		expect(await after.restoreHandle("done")).toBe("retired");
		expect(await after.restoreHandle("never-admitted")).toBeUndefined();
	});

	it("does not queue a restored input its record already delivered", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		release();
		await run;

		await harness.session.restoreQueuedInput({
			clientMessageId: "c-1",
			text: "once",
			mode: "followUp",
			enqueueOrder: 1,
		});

		expect(harness.session.getQueuedInputs()).toEqual([]);
	});
});
