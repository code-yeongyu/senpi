import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../src/core/external-admission.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function harness(): Promise<Harness> {
	const created = await createHarness({ persistSession: true });
	harnesses.push(created);
	return created;
}

function nextEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

async function holdTurn(target: Harness): Promise<{ release: () => void; settled: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	target.setResponses([
		async () => {
			await gate.promise;
			return fauxAssistantMessage("first reply");
		},
		fauxAssistantMessage("second reply"),
		fauxAssistantMessage("third reply"),
	]);
	const started = nextEvent(target, "agent_start");
	const settled = target.session.prompt("start work");
	await started;
	return { release: () => gate.resolve(), settled };
}

function deliveryEntries(target: Harness): readonly { delivery_id: string | undefined; content: unknown }[] {
	return target.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE
			? [
					{
						delivery_id: deliveryIdOf({ role: "custom", ...entry, display: entry.display, timestamp: 0 }),
						content: entry.content,
					},
				]
			: [],
	);
}

describe("external message admission", () => {
	it("starts a turn when idle, writes delivery_id provenance, and moves the id from pending to emitted", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "d-idle", text: "hello from A", deliverAs: "followUp" })).toEqual({
			kind: "started",
			turn_epoch: 0,
		});
		expect(admission.list().pending).toEqual(["d-idle"]);
		expect(admission.admit({ delivery_id: "d-idle", text: "hello from A", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
		await idle;
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-idle"] });
		expect(deliveryEntries(target)).toEqual([{ delivery_id: "d-idle", content: "hello from A" }]);
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		expect(readFileSync(file, "utf8")).toContain('"delivery_id":"d-idle"');
		expect(admission.admit({ delivery_id: "d-idle", text: "again", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
	});

	it("mid-turn: CAS on turn_epoch, one enqueue per delivery_id across both queues", async () => {
		const target = await harness();
		const turn = await holdTurn(target);
		const steer = vi.spyOn(target.agent, "steer");
		const followUp = vi.spyOn(target.agent, "followUp");
		const admission = target.session.externalAdmission;
		const epoch = admission.turnEpoch;
		expect(epoch).toBe(1);

		expect(admission.admit({ delivery_id: "s-stale", text: "x", deliverAs: "steer", expected_turn_id: 0 })).toEqual({
			kind: "turn_conflict",
			turn_epoch: 1,
		});
		expect(admission.admit({ delivery_id: "s-none", text: "x", deliverAs: "steer" }).kind).toBe("turn_conflict");
		expect(
			admission.admit({ delivery_id: "s-1", text: "steer me", deliverAs: "steer", expected_turn_id: epoch }).kind,
		).toBe("steered");
		expect(admission.admit({ delivery_id: "f-1", text: "later", deliverAs: "followUp" }).kind).toBe("queued");
		expect(
			admission.admit({ delivery_id: "f-1", text: "later", deliverAs: "steer", expected_turn_id: epoch }).kind,
		).toBe("already_admitted");
		expect(admission.admit({ delivery_id: "s-1", text: "steer me", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(admission.list()).toEqual({ pending: ["s-1", "f-1"], emitted: [] });

		turn.release();
		await turn.settled;
		await target.session.waitForIdle();
		expect(deliveryEntries(target).map((entry) => entry.delivery_id)).toEqual(["s-1", "f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["s-1", "f-1"] });
	});

	it("holds while the user has a draft, without enqueueing anything", async () => {
		const target = await harness();
		const admission = target.session.externalAdmission;
		admission.setEditorSource(() => ({ hold_reason: "draft", revision: 3 }));
		expect(admission.gate()).toEqual({ can_admit: false, hold_reason: "draft", editor_revision: 3, turn_epoch: 0 });
		expect(admission.admit({ delivery_id: "d-held", text: "x", deliverAs: "followUp" }).kind).toBe("held_draft");
		expect(admission.list()).toEqual({ pending: [], emitted: [] });
		admission.setEditorSource(() => ({ revision: 4 }));
		expect(admission.gate()).toEqual({ can_admit: true, editor_revision: 4, turn_epoch: 0 });
	});

	it("drops queued deliveries from the ledger when the runtime queues are cleared", async () => {
		const target = await harness();
		const turn = await holdTurn(target);
		const admission = target.session.externalAdmission;
		expect(admission.admit({ delivery_id: "f-clear", text: "x", deliverAs: "followUp" }).kind).toBe("queued");
		target.session.clearQueue();
		expect(admission.list().pending).toEqual([]);
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();
		expect(deliveryEntries(target)).toEqual([]);
	});

	it("exposes the same admission through pi.session", async () => {
		const target = await harness();
		await target.session.bindExtensions({});
		const runtime = target.session.resourceLoader.getExtensions().runtime;
		expect(runtime.sessionControl?.listAdmittedDeliveries()).toEqual({ pending: [], emitted: [] });
		expect(runtime.sessionControl?.admissionGate()).toMatchObject({ can_admit: true, turn_epoch: 0 });
		const registration = await runtime.sessionControl?.registerControlEndpoint({
			inboxDir: target.tempDir,
			drain: () => undefined,
		});
		expect(registration).toEqual(
			process.platform === "win32"
				? { status: "unsupported", reason: "unsupported_platform" }
				: { status: "unsupported", reason: "unsupported_mode" },
		);
	});
});

describe("persistHeaderNow and the header-only exit rule", () => {
	it("writes the header before any assistant message and keeps appending after it", async () => {
		const target = await harness();
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		expect(existsSync(file)).toBe(false);
		await target.sessionManager.persistHeaderNow();
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}");
		expect(header).toMatchObject({ type: "session", id: target.session.sessionId });
		target.setResponses([fauxAssistantMessage("reply")]);
		await target.session.prompt("hi");
		const types = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).type);
		expect(types.filter((type) => type === "session")).toHaveLength(1);
		expect(types).toContain("message");
		expect(await target.sessionManager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("entries persisted while the asynchronous header write runs land after the header, once", async () => {
		const target = await harness();
		const manager = target.sessionManager;
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		const writing = manager.persistHeaderNow();
		manager.appendMessage({ role: "user", content: "during the header write", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("assistant during the header write"));
		expect(manager.isTranscriptFlushed()).toBe(false);
		await writing;
		expect(manager.isTranscriptFlushed()).toBe(true);
		manager.appendCustomEntry("after", { n: 1 });
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", id: target.session.sessionId });
		expect(lines.slice(1).map((line) => line.id)).toEqual(manager.getEntries().map((entry) => entry.id));
	});

	it("removes a header-only file and returns to buffering", async () => {
		const target = await harness();
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		await target.sessionManager.persistHeaderNow();
		expect(await target.sessionManager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(target.sessionManager.isTranscriptFlushed()).toBe(false);
	});
});
