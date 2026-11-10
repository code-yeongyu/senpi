// S31 (brain/hand split, F40): a model-backed tool on a hand gets its completion from the brain that owns the call,
// and nothing the hand names about credentials or endpoints reaches the brain's completion.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MODEL_PLANE, type ModelPlaneRequest, serveModelPlane } from "../../src/execution/plane-model.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import { assistant, cleanups, link, PROMPT, resultText, runCall, startHand } from "./model-plane-fixture.ts";

describe("model plane (S31): a hand's model-backed tool completes on the brain", () => {
	it("serves the completion with the brain's model and returns it to the tool", async () => {
		const { brain, hand } = link();
		const seen: ModelPlaneRequest[] = [];
		const host = createRemoteToolHost({
			transport: brain,
			placement: "split-local",
			planes: {
				[MODEL_PLANE]: serveModelPlane(async (request) => {
					seen.push(request);
					return assistant("from the brain");
				}),
			},
		});
		cleanups.push(() => host.close());
		startHand(hand, () => PROMPT);

		const result = await runCall(host);

		expect(resultText(result)).toBe("from the brain");
		expect(seen).toEqual([PROMPT]);
	});

	it("never passes credentials or endpoints the hand names to the brain's completion", async () => {
		const { brain, hand } = link();
		const seen: ModelPlaneRequest[] = [];
		const host = createRemoteToolHost({
			transport: brain,
			placement: "split-local",
			planes: {
				[MODEL_PLANE]: serveModelPlane(async (request) => {
					seen.push(request);
					return assistant("ok");
				}),
			},
		});
		cleanups.push(() => host.close());
		startHand(hand, () => ({
			model: { provider: "anthropic", id: "some-model", baseUrl: "https://attacker.invalid", apiKey: "k" },
			context: PROMPT.context,
			options: { maxTokens: 64, apiKey: "k", headers: { authorization: "x" }, baseUrl: "https://attacker.invalid" },
			apiKey: "k",
		}));

		await runCall(host);

		expect(seen).toEqual([{ model: { provider: "anthropic", id: "some-model" }, ...PROMPT }]);
	});

	it("refuses every model request when the brain serves no model plane", async () => {
		const { brain, hand } = link();
		const host = createRemoteToolHost({ transport: brain, placement: "split-local" });
		cleanups.push(() => host.close());
		startHand(hand, () => PROMPT);

		const result = await runCall(host);

		expect(resultText(result)).toBe("refused:plane_unavailable");
		expect(result.messages[0]?.isError).toBe(true);
	});

	it("aborts the brain's open completion when the parent call is aborted", async () => {
		const { brain, hand } = link();
		let started: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			started = resolve;
		});
		let completionSignal: AbortSignal | undefined;
		const host = createRemoteToolHost({
			transport: brain,
			placement: "split-local",
			planes: {
				[MODEL_PLANE]: serveModelPlane(
					(_request, signal) =>
						new Promise<AssistantMessage>((_resolve, reject) => {
							completionSignal = signal;
							signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							started();
						}),
				),
			},
		});
		cleanups.push(() => host.close());
		startHand(hand, () => PROMPT);
		const controller = new AbortController();

		const running = runCall(host, { signal: controller.signal });
		await opened;
		controller.abort();
		await running;

		expect(completionSignal?.aborted).toBe(true);
	});
});
