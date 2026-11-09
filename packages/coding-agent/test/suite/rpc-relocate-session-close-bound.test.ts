/**
 * senpi#5903: closing a session waits for its running relocation tool calls to hand back their answers (senpi#5811),
 * but only as long as the close path's grace window. Here the relocation call can never end on its own: a later call of
 * the same batch is held in its `tool_call` hook until the run is aborted, and the batch releases no call before every
 * call is prepared. `close_session` must still answer once the grace window has passed, and the run must be aborted.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { nextEvent } from "./rpc-release-host-support.ts";
import { DESKTOP, relocationHost } from "./rpc-relocate-session-host-support.ts";

/** The grace window `startReleaseHost` gives its registry. */
const CLOSE_GRACE_MS = 2_000;

/** The builtin relocation tools, plus a `hold` tool whose `tool_call` hook returns only once the run is aborted. */
function withHeldCall(entered: () => void, released: () => void): ExtensionFactory {
	return (pi) => {
		relocateSessionExtension(pi);
		pi.registerTool({
			name: "hold",
			label: "Hold",
			description: "Waits.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				return { content: [{ type: "text", text: "held" }], details: {} };
			},
		});
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "hold") return;
			entered();
			const signal = ctx.signal;
			if (signal === undefined || signal.aborted) return;
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			released();
		});
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("closing a session while a relocation call cannot end on its own (senpi#5903)", () => {
	it("answers close_session once the grace window has passed, and aborts the run", async () => {
		// Given: the agent calls relocate_session and then hold in one batch; hold's hook waits for the run's abort.
		let entered: () => void = () => {};
		const holding = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let aborted = false;
		const { host, sessionId, session } = await relocationHost({
			extension: withHeldCall(
				() => entered(),
				() => {
					aborted = true;
				},
			),
			answer: () => {},
		});
		await using _host = host;
		host.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" }), fauxToolCall("hold", {})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const settled = nextEvent(session, "agent_settled");
		void host.send({ type: "prompt", id: "work", sessionId, message: "run the heavy build" }, DESKTOP);
		await holding;

		// When: the desktop closes the session, and exactly one grace window passes.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const closed = host.send({ type: "close_session", id: "bye", sessionId }, DESKTOP);
		await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
		const abortedByDeadline = aborted;
		vi.useRealTimers();
		// A close that never reached its teardown still holds the run; abort it so the host can be torn down.
		if (!abortedByDeadline) await session.abort();

		// Then: by the deadline the teardown aborted the run, the close answered, and no move was reported.
		expect(abortedByDeadline).toBe(true);
		expect(await closed).toMatchObject({ success: true });
		await settled;
		const result = session.messages.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "relocate_session",
		);
		expect(result?.details).not.toMatchObject({ status: "scheduled" });
	});
});
