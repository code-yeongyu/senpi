// senpi#5728 (S36): EQ's witness assertion reads one `execution-pipeline` receipt per model-issued call, and production
// writes none. The switch that turns receipts on must survive the legacy scheduler's removal.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

async function receiptsFor(switchValue: string | undefined) {
	if (switchValue !== undefined) vi.stubEnv("SENPI_EXECUTION_PIPELINE", switchValue);
	const harness = await createHarness({
		persistSession: true,
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "receipt_probe",
					label: "probe",
					description: "fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const calls = [
			{ ...fauxToolCall("receipt_probe", {}), id: "call-a" },
			{ ...fauxToolCall("receipt_probe", {}), id: "call-b" },
		];
		harness.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("run");
		return harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "execution-pipeline" ? [entry.data] : [],
			);
	} finally {
		harness.cleanup();
	}
}

it("writes no receipt when the switch is unset", async () => {
	expect(await receiptsFor(undefined)).toEqual([]);
});

it.each(["default", "prepared"])("writes one prepared receipt per call when the switch is %s", async (value) => {
	expect(await receiptsFor(value)).toEqual([
		{ pipeline: "prepared", toolCallId: "call-a" },
		{ pipeline: "prepared", toolCallId: "call-b" },
	]);
});

it("refuses the removed legacy scheduler instead of running the default under its name", async () => {
	await expect(receiptsFor("legacy")).rejects.toThrow("SENPI_EXECUTION_PIPELINE must be default or prepared");
});
