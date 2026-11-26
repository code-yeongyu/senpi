import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { heldTurn, nextEvent } from "../rpc-release-host-support.ts";
import { relocationRig, stillWritableHere } from "../rpc-relocate-session-support.ts";

describe("a scheduled relocation being cleared", () => {
	it.each(["disconnected", "aborted", "withdrawn"] as const)(
		"delivers exactly one agent outcome when %s",
		async (reason) => {
			// Given: the real tool has returned scheduled and the closing response is held.
			const rig = await relocationRig({
				capabilities: ["session_relocation"],
				host: () => ({ data: { accepted: true, moveId: "mv-dropped", target: "Studio" } }),
			});
			const closing = Promise.withResolvers<void>();
			rig.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
					stopReason: "toolUse",
				}),
				reason === "aborted"
					? heldTurn
					: async () => {
							await closing.promise;
							return fauxAssistantMessage("done");
						},
			]);
			const toolDone = nextEvent(rig.harness.session, "tool_execution_end");
			const turn = rig.harness.session.prompt("continue on Studio");
			try {
				await toolDone;
				// When: the schedule is cleared, including repeated notifications of the same cause.
				for (let count = 0; count < 2; count++) {
					switch (reason) {
						case "disconnected":
							rig.handler.connectionDetached("sole");
							break;
						case "aborted":
							await rig.handler.handleInputLine(JSON.stringify({ type: "abort", id: `abort-${count}` }));
							break;
						case "withdrawn":
							await rig.handler.handleInputLine(
								JSON.stringify({ type: "set_client_info", id: `withdraw-${count}`, capabilities: [] }),
							);
							break;
					}
				}
			} finally {
				closing.resolve();
				await turn;
				await rig.harness.session.agent.waitForIdle();
			}
			try {
				// Then: one typed correction reaches agent context; later settlements cannot repeat it.
				const outcomes = rig.harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "session_relocation",
				);
				expect(outcomes).toEqual([
					expect.objectContaining({
						details: expect.objectContaining({
							status: "dropped",
							reason,
							moveId: "mv-dropped",
							target: "Studio",
						}),
					}),
				]);
				expect(rig.harness.eventsOfType("agent_start")).toHaveLength(1);
				await stillWritableHere(rig);
				expect(
					rig.harness.session.messages.filter(
						(message) => message.role === "custom" && message.customType === "session_relocation",
					),
				).toEqual(outcomes);
				expect(rig.records.filter((record) => record.type === "relocation_due")).toEqual([]);
			} finally {
				await rig.cleanup();
			}
		},
	);

	it.each([false, true])("persists the abort notice on close with a racing detach: %s", async (detach) => {
		// Given: an accepted relocation with the closing model response still running.
		const rig = await relocationRig({
			capabilities: ["session_relocation"],
			host: () => ({ data: { accepted: true, moveId: "mv-close", target: "Studio" } }),
		});
		try {
			rig.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
					stopReason: "toolUse",
				}),
				heldTurn,
			]);
			const toolDone = nextEvent(rig.harness.session, "tool_execution_end");
			const turn = rig.harness.session.prompt("continue on Studio");
			await toolDone;

			// When: the user aborts and the session closes without another model request.
			if (detach) {
				const stop = rig.harness.session.subscribe((event) => {
					if (event.type !== "agent_end") return;
					stop();
					rig.handler.connectionDetached("sole");
				});
			}
			await rig.handler.handleInputLine(JSON.stringify({ type: "abort", id: "abort-close" }));
			await turn;
			await rig.harness.session.agent.waitForIdle();
			const file = rig.harness.session.sessionFile;
			if (file === undefined) throw new Error("expected a persisted session");
			await rig.handler.dispose();
			rig.harness.session.dispose();

			// Then: the saved conversation already contains exactly one typed correction.
			const entries: { customType?: string }[] = (await readFile(file, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(entries.filter((entry) => entry.customType === "session_relocation")).toEqual([
				expect.objectContaining({
					type: "custom_message",
					display: false,
					details: { status: "dropped", reason: "aborted", moveId: "mv-close", target: "Studio" },
				}),
			]);
			expect(rig.harness.eventsOfType("agent_start")).toHaveLength(1);
		} finally {
			await rig.cleanup();
		}
	});
});
