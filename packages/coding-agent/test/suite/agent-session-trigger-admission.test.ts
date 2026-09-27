import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, getUserTexts } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function withinDeadline(promise: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Prompt admission waited for the held extension turn")), 1_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("prompt admission during an extension-triggered turn", () => {
	it.each([
		{ streamingBehavior: "steer", abort: false },
		{ streamingBehavior: "followUp", abort: false },
		{ streamingBehavior: "steer", abort: true },
		{ streamingBehavior: "followUp", abort: true },
	] as const)(
		"acknowledges and delivers $streamingBehavior exactly once while custom preflight is held (abort=$abort)",
		async ({ streamingBehavior, abort }) => {
			const entered = deferred();
			const release = deferred();
			const accepted = deferred();
			const dispositions: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async (event) => {
							if (event.trigger !== "extension") return;
							entered.resolve();
							await release.promise;
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
			harness.setResponses([fauxAssistantMessage("handled mail"), fauxAssistantMessage("handled task")]);
			const custom = harness.session.sendCustomMessage(
				{ customType: "startup-mail", content: "queued team mail", display: false },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			await entered.promise;
			expect(harness.session.isStreaming).toBe(false);
			const prompt = harness.session.prompt("initial task", {
				streamingBehavior,
				source: "rpc",
				promptDisposition: (disposition) => dispositions.push(disposition),
				preflightResult: (success) => {
					if (success) accepted.resolve();
				},
			});
			try {
				await withinDeadline(accepted.promise);
				expect(dispositions).toEqual(["queued"]);
				expect(harness.faux.state.callCount).toBe(0);
				expect(harness.session.pendingMessageCount).toBe(1);
				const aborted = abort ? harness.session.abort() : undefined;
				release.resolve();
				await Promise.all([custom, prompt, aborted]);
				if (abort) {
					expect(harness.faux.state.callCount).toBe(0);
					expect(harness.session.messages).toEqual([]);
					expect(harness.session.pendingMessageCount).toBe(1);
					await harness.session.prompt("resume");
				}
				expect(getUserTexts(harness)).toEqual(abort ? ["resume", "initial task"] : ["initial task"]);
				expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(1);
				expect(harness.eventsOfType("agent_start")).toHaveLength(1);
				expect(harness.session.pendingMessageCount).toBe(0);
			} finally {
				release.resolve();
				await Promise.all([custom, prompt]);
				harness.cleanup();
			}
		},
	);
});
