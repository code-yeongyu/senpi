import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { TURN_END_SKIPPED_AFTER_SHUTDOWN } from "../../../src/core/agent-session.ts";
import { emitSessionShutdownEvent } from "../../../src/core/extensions/runner.ts";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const MISLEADING = "turn_end could not resolve the persisted assistant entry ID";

describe("turn_end boundary when the session shuts down mid-turn (senpi#2995)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("Given a session shut down while the next response streams when the turn ends then the boundary reports the shutdown, not a missing entry", async () => {
		// given
		let followUpStarted = () => {};
		const followUp = new Promise<void>((resolve) => {
			followUpStarted = resolve;
		});
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {});
				},
			],
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		let boundaryReported = () => {};
		const boundaryReport = new Promise<void>((resolve) => {
			boundaryReported = resolve;
		});
		harness.getExtensionRunner().onError((error) => {
			errors.push(error);
			if (error.extensionPath === "<boundary>") boundaryReported();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async (_context, options) => {
				followUpStarted();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);

		// when: the CLI's signal shutdown (runtime dispose) runs while the follow-up response streams
		void harness.session.prompt("go").catch(() => undefined);
		await followUp;
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.session.dispose();
		await boundaryReport;

		// then
		const boundary = errors.filter((error) => error.extensionPath === "<boundary>").map((error) => error.error);
		expect(boundary).not.toContain(MISLEADING);
		expect(boundary).toEqual([TURN_END_SKIPPED_AFTER_SHUTDOWN]);
	});
});
