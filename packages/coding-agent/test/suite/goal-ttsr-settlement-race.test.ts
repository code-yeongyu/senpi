import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("user abort racing settlement-owned recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		["before", true],
		["after", false],
	] as const)("cancels TTSR when a blocking agent_settled handler runs %s TTSR", async (_label, beforeTtsr) => {
		const gate = createSettlementGate();
		let sessionAbortCount = 0;
		const observer: ExtensionFactory = (pi) => {
			pi.on("session_abort", () => {
				sessionAbortCount += 1;
			});
		};
		const extensions = beforeTtsr
			? [goalExtension, gate.extension, ttsrExtension, observer]
			: [goalExtension, ttsrExtension, gate.extension, observer];
		const harness = await createHarness({ persistSession: true, extensionFactories: extensions });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, `Cancel settlement recovery ${_label} TTSR`);
		harness.setResponses([unavailableToolResponse()]);

		const prompt = harness.session.prompt("continue monitoring");
		await gate.started;
		const abort = harness.session.abort();
		gate.release();
		await Promise.all([abort, prompt]);

		expect(sessionAbortCount).toBe(1);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" });
		expect(harness.agent.hasQueuedMessages()).toBe(false);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("launches Goal-owned recovery after a terminal system error settles", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } },
			extensionFactories: [goalExtension, ttsrExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Recover the terminal system error");
		harness.setResponses([
			controlTokenLeakResponse(),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("goal recovery completed")]),
		]);

		await harness.session.prompt("continue monitoring");

		expect(harness.faux.getCallLog().length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(harness.faux.getCallLog()[1]?.context.messages)).toContain(
			"Continue working toward the active thread goal.",
		);
		expect(await readGoal(ref)).toMatchObject({ status: "complete" });
	});

	it("drops Goal-owned recovery when the user aborts at the public agent_end boundary", async () => {
		let abort: Promise<void> | undefined;
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } },
			extensionFactories: [goalExtension, ttsrExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Drop stale Goal recovery");
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" && abort === undefined) abort = harness.session.abort();
		});
		harness.setResponses([controlTokenLeakResponse(), fauxAssistantMessage([fauxText("ordinary user response")])]);

		await harness.session.prompt("continue monitoring");
		await abort;

		expect(harness.agent.hasQueuedMessages()).toBe(false);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" });
		expect(harness.faux.getCallLog()).toHaveLength(1);

		await harness.session.prompt("ordinary follow-up");

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(JSON.stringify(harness.faux.getCallLog()[1]?.context.messages)).not.toContain(
			"Continue working toward the active thread goal.",
		);
	});

	it("resumes Goal recovery after a canceled settlement delivery", async () => {
		let abort: Promise<void> | undefined;
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } },
			extensionFactories: [goalExtension, ttsrExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Resume canceled Goal recovery");
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" && abort === undefined) abort = harness.session.abort();
		});
		harness.setResponses([
			controlTokenLeakResponse(),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("resumed recovery completed")]),
		]);

		await harness.session.prompt("continue monitoring");
		await abort;
		expect(await readGoal(ref)).toMatchObject({ status: "blocked" });

		const recoverySettled = waitForAgentSettled(harness.session);
		await harness.session.prompt("/goal resume");
		await recoverySettled;

		expect(harness.faux.getCallLog().length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(harness.faux.getCallLog()[1]?.context.messages)).toContain(
			"Continue working toward the active thread goal.",
		);
		expect(await readGoal(ref)).toMatchObject({ status: "complete" });
	});
});

interface SettlementGate {
	readonly extension: ExtensionFactory;
	readonly started: Promise<void>;
	readonly release: () => void;
}

function createSettlementGate(): SettlementGate {
	let signalStarted: (() => void) | undefined;
	let release: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		extension: (pi) => {
			pi.on("agent_settled", async () => {
				signalStarted?.();
				await released;
			});
		},
		started,
		release: () => release?.(),
	};
}

function unavailableToolResponse() {
	return fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')]);
}

function controlTokenLeakResponse() {
	const leaked = ["<", "|", "sep", "|", ">"].join("");
	return fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${leaked} ${leaked} trailing ${"x".repeat(400)}`)]);
}

function waitForAgentSettled(session: Harness["session"]): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("Timed out waiting for resumed Goal recovery to settle"));
		}, 5_000);
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}
