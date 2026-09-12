import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * A tool that ignores its abort signal and never settles must not wedge the
 * session: abort() has to return and the next prompt has to be admitted.
 *
 * The agent loop used to await the tool's own promise with no race against the
 * abort signal, so an abort landing after execute() was entered produced no
 * agent_end, the session never went idle, the session work barrier stayed held,
 * and every later prompt parked behind it. In the TUI that surfaced as
 * "Running <tool>" counting up while ESC did nothing.
 */

const RELEASE_BOUND_MS = 15_000;

async function boundedOutcome(work: Promise<string>, hungLabel: string): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve(hungLabel), RELEASE_BOUND_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("970: aborting a stuck tool releases the session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns from abort and admits the next prompt", async () => {
		let announceEntered: (() => void) | undefined;
		const toolEntered = new Promise<void>((resolve) => {
			announceEntered = resolve;
		});

		const stuckTool = {
			name: "stuck_tool",
			label: "Stuck",
			description: "Ignores its abort signal and never settles",
			parameters: Type.Object({}),
			async execute() {
				announceEntered?.();
				return await new Promise<never>(() => {});
			},
		};

		const harness = await createHarness({ tools: [stuckTool as never] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stuck_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("queued prompt ran"),
		]);

		void harness.session.prompt("start the stuck tool").catch(() => undefined);
		await toolEntered;

		const abortOutcome = await boundedOutcome(
			harness.session
				.abort()
				.then(() => "abort-returned")
				.catch((error: unknown) => `abort-threw:${String(error).slice(0, 80)}`),
			"abort-hung",
		);
		expect(abortOutcome).toBe("abort-returned");

		const queuedOutcome = await boundedOutcome(
			harness.session
				.prompt("queued after abort")
				.then(() => "queued-admitted")
				.catch((error: unknown) => `queued-rejected:${String(error).slice(0, 80)}`),
			"queued-hung",
		);
		expect(queuedOutcome).toBe("queued-admitted");
	}, 60_000);
});
