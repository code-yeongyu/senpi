import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHarness, type HarnessOptions } from "../harness.ts";

export const wake = { customType: "senpi-codemode:notification", content: "held completion", display: false };

export async function heldHarness(options: HarnessOptions = {}) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		...options,
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test event.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("done")])),
	]);
	return { h, entered, release };
}
