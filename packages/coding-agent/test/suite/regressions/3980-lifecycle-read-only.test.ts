import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3980: reading the lifecycle (get_state, session.lifecycle) never writes to the transcript.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

function lifecycleRecordCount(h: Harness): number {
	return h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle").length;
}

it("writes nothing when a client reads the lifecycle while a user shell command runs", async () => {
	// Given a settled session whose user shell command is still running.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("Reply.")]);
	await runToAgentIdle(h, () => h.session.prompt("Request"));
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finish!: () => void;
	const operations: BashOperations = {
		exec: () => {
			started();
			return new Promise((resolve) => {
				finish = () => resolve({ exitCode: 0 });
			});
		},
	};
	const bash = h.session.executeBash("long command", undefined, { operations });
	await running;
	const before = lifecycleRecordCount(h);

	// When a client reads the lifecycle repeatedly.
	const reads = [h.session.lifecycle.state, h.session.lifecycle.state, h.session.lifecycle.state];

	// Then the reads see the running command and wrote nothing.
	expect(reads).toEqual(["running", "running", "running"]);
	expect(lifecycleRecordCount(h)).toBe(before);
	finish();
	await bash;
});
