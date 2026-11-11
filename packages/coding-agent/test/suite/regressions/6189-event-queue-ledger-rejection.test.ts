import type { InternalAgentChannel } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchInternalAgent } from "../../../../agent/src/internal-events.ts";
import { createStructuredHarness, type StructuredHarness } from "../structured-lane-sdk-harness.ts";

/**
 * senpi#6189 (review LOW): the stall ledger records every entry queued on the session's event queue. Recording one
 * must not mark the queue handled: a structured listener that throws while a block control is delivered rejected
 * the queue with no handler before the ledger existed, so the process saw an unhandled rejection, and it still must.
 */

const channels = vi.hoisted((): InternalAgentChannel[] => []);

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
	return {
		...actual,
		createInternalAgentChannel: () => {
			const channel = actual.createInternalAgentChannel();
			channels.push(channel);
			return channel;
		},
	};
});

/**
 * The first unhandled rejection the process reports while `body` runs. The runtime reports one after the microtask
 * queue drains, before the next macrotask; a sentinel rejected after that turn is reported after anything `body`
 * caused, so the wait ends on an event, not on elapsed time. The test runner's own listeners are detached meanwhile so
 * an expected report does not fail the run.
 */
async function unhandledRejectionDuring(body: () => void): Promise<unknown> {
	const sentinel = new Error("unhandled-rejection sentinel");
	const seen: unknown[] = [];
	const runnerListeners = process.listeners("unhandledRejection");
	process.removeAllListeners("unhandledRejection");
	let onUnhandled!: (reason: unknown) => void;
	const settled = new Promise<void>((resolve) => {
		onUnhandled = (reason: unknown) => {
			if (reason === sentinel) resolve();
			else seen.push(reason);
		};
	});
	process.on("unhandledRejection", onUnhandled);
	try {
		body();
		await new Promise((resolve) => setImmediate(resolve));
		void Promise.reject(sentinel);
		await settled;
		return seen[0];
	} finally {
		process.off("unhandledRejection", onUnhandled);
		for (const listener of runnerListeners) process.on("unhandledRejection", listener);
	}
}

const harnesses: StructuredHarness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

it("a structured listener's throw on a queued block control still reaches unhandledRejection", async () => {
	const harness = await createStructuredHarness();
	harnesses.push(harness);
	const channel = channels.at(-1);
	expect(channel).toBeDefined();
	const control = {
		type: "message_tool_arguments_reset" as const,
		contentIndex: 0,
		rawArgumentPrefix: "",
		parsedThrough: 0,
	};
	const failure = new Error("structured listener failed");
	harness.session.subscribeStructured((record) => {
		if (record === control) throw failure;
	});

	// given a block control queued on the session's event queue, whose structured listener throws
	// when the queue delivers it and nothing else is queued behind it
	const reason = await unhandledRejectionDuring(() => {
		void dispatchInternalAgent(channel, { progress: control });
	});

	// then the rejection is reported to the process exactly as it was before the ledger recorded the entry
	expect(reason).toBe(failure);
});
