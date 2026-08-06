import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("late user abort during agent_end dispatch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves user intent when a handler blocks before Goal and TTSR", async () => {
		await runLateJoinScenario({
			harnesses,
			objective: "Honor Escape before Goal handles the end",
			beforeGoal: true,
			responses: [fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')])],
		});
	});

	it("cancels remediation when a handler blocks after TTSR handled agent_end", async () => {
		await runLateJoinScenario({
			harnesses,
			objective: "Cancel remediation after TTSR observed the end",
			beforeGoal: false,
			responses: [fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')])],
		});
	});

	it("cancels a provider retry admitted before the late user join", async () => {
		const leaked = ["<", "|", "sep", "|", ">"].join("");
		await runLateJoinScenario({
			harnesses,
			objective: "Cancel provider retry after TTSR observed the end",
			beforeGoal: false,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			responses: [
				fauxAssistantMessage([
					fauxThinking(`Thinking... ${leaked} ${leaked} ${leaked} trailing ${"x".repeat(400)}`),
				]),
				fauxAssistantMessage([fauxText("must not run")]),
			],
		});
	});

	it("cancels remediation when Escape arrives from the public agent_end boundary", async () => {
		const abortSources: Array<string | undefined> = [];
		let sessionAbortCount = 0;
		let abort: Promise<void> | undefined;
		let repeatedAbort: Promise<void> | undefined;
		let harness: Harness;
		harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				ttsrExtension,
				(pi) => {
					pi.on("agent_end", (event) => {
						abortSources.push(event.abortSource);
					});
					pi.on("session_abort", () => {
						sessionAbortCount += 1;
						repeatedAbort ??= harness.session.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Cancel remediation after extension dispatch");
		const originalAbort = harness.agent.abort.bind(harness.agent);
		const abortSpy = vi.spyOn(harness.agent, "abort").mockImplementation(() => {
			originalAbort();
		});
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" && abort === undefined) abort = harness.session.abort();
		});
		harness.setResponses([fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')])]);

		await harness.session.prompt("continue monitoring");
		await abort;
		await repeatedAbort;

		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(abortSources).toEqual(["system"]);
		expect(sessionAbortCount).toBe(1);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" });
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});

interface LateJoinScenario {
	readonly harnesses: Harness[];
	readonly objective: string;
	readonly beforeGoal: boolean;
	readonly responses: Parameters<Harness["setResponses"]>[0];
	readonly settings?: {
		readonly retry: { readonly enabled: boolean; readonly maxRetries: number; readonly baseDelayMs: number };
	};
}

async function runLateJoinScenario(options: LateJoinScenario): Promise<void> {
	const abortSources: Array<string | undefined> = [];
	let sessionAbortCount = 0;
	let signalAgentEndStarted: (() => void) | undefined;
	let releaseAgentEnd: (() => void) | undefined;
	const agentEndStarted = new Promise<void>((resolve) => {
		signalAgentEndStarted = resolve;
	});
	const agentEndRelease = new Promise<void>((resolve) => {
		releaseAgentEnd = resolve;
	});
	const blockingExtension: ExtensionFactory = (pi) => {
		pi.on("agent_end", async () => {
			signalAgentEndStarted?.();
			await agentEndRelease;
		});
	};
	const observerExtension: ExtensionFactory = (pi) => {
		pi.on("agent_end", (event) => {
			abortSources.push(event.abortSource);
		});
		pi.on("session_abort", () => {
			sessionAbortCount += 1;
		});
	};
	const orderedExtensions = options.beforeGoal
		? [blockingExtension, goalExtension, ttsrExtension, observerExtension]
		: [goalExtension, ttsrExtension, blockingExtension, observerExtension];
	const harness = await createHarness({
		persistSession: true,
		...(options.settings === undefined ? {} : { settings: options.settings }),
		extensionFactories: orderedExtensions,
	});
	options.harnesses.push(harness);
	await harness.session.bindExtensions({});
	const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
	await createGoal(ref, options.objective);
	const originalAbort = harness.agent.abort.bind(harness.agent);
	const abortSpy = vi.spyOn(harness.agent, "abort").mockImplementation(() => {
		originalAbort();
	});
	harness.setResponses(options.responses);

	const prompt = harness.session.prompt("continue monitoring");
	await agentEndStarted;
	const abort = harness.session.abort();
	releaseAgentEnd?.();
	await Promise.all([abort, prompt]);

	expect(abortSpy).toHaveBeenCalledTimes(1);
	expect(abortSources).toEqual(["user"]);
	expect(sessionAbortCount).toBe(1);
	expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" });
	expect(harness.faux.getCallLog()).toHaveLength(1);
}
