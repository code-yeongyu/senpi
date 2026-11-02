/**
 * senpi#1472, restart half: the `eval` summary clamp used to rewrite the assistant
 * message the provider had produced, so the sidecar's `assistantContentHash` (taken
 * at the commit boundary, before preparation) no longer matched the assistant the
 * branch carried afterwards. `bindingFromStoredBranch` then rejected a perfectly
 * good binding and the next start re-sent the whole conversation as
 * `flatten / registry_miss` (oh-my-openagent#8424 measured 905,874 bytes with
 * cache_read 0 for one such re-send).
 *
 * This drives the REAL wiring: message_update -> message_end (sidecar written) ->
 * the agent loop's tool-argument preparation against the same message the branch
 * holds -> restart admission. The shipped `eval` tool provides the shim, so the
 * fixture cannot drift away from the tool that caused the report.
 */

import { prepareToolArguments } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEvalTool } from "../../../../senpi-codemode/src/tool/eval-tool.ts";
import { bindingFromStoredBranch } from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding.ts";
import { readStoredBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding-store.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import {
	assistant,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	residentEntry,
	sessionFixture,
} from "../../helpers/anthropic-subscription-restart-fixture.ts";

// Preparation still normalizes whitespace, so the executed summary differs from the message.
const RAW_SUMMARY = "  inspect   the cache\nstate  ";
const UNUSED = () => Promise.reject(new Error("not reached: this regression only prepares arguments"));

const evalTool = createEvalTool({
	enabledLanguages: { js: true, py: false, rb: false, jl: false },
	kernelManager: { getKernel: UNUSED },
	cellTimeoutSeconds: 30,
	executeTool: UNUSED,
});

function evalAssistant(): AssistantMessage {
	return {
		...assistant(),
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "eval",
				arguments: { language: "js", code: "return 1", summary: RAW_SUMMARY },
			},
		],
		stopReason: "toolUse",
	} as AssistantMessage;
}

function toolCallOf(message: AssistantMessage) {
	const block = message.content[0];
	if (block?.type !== "toolCall") throw new Error("fixture must start with an eval tool call");
	return block;
}

afterEach(() => {
	cleanupRestartFixture();
});

describe("issue #1472: preparing eval arguments keeps the restart binding admissible", () => {
	it("admits the stored binding after the shipped eval shim prepared the same assistant", async () => {
		const { sessionFile, branch } = sessionFixture();
		residentEntry();
		const { api, handlers } = fakeExtension(branch);
		registerSessionRegistry(api);
		const ctx = context(sessionFile, branch);
		const message = evalAssistant();

		await emit(handlers, "message_update", { message }, ctx);
		await emit(handlers, "message_end", { message }, ctx);
		// The agent loop prepares the call for execution AFTER the commit boundary ran,
		// against the very object the branch now carries.
		const executed = prepareToolArguments(evalTool.prepareArguments, toolCallOf(message).arguments) as {
			summary?: string;
		};
		branch.push({ type: "message", id: "assistant-entry", message });

		const stored = await readStoredBinding(sessionFile);
		expect(stored).toBeDefined();
		expect(bindingFromStoredBranch(branch, stored!)).toMatchObject({ sdkSessionId: stored!.sdkSessionId });
		expect(toolCallOf(message).arguments.summary).toBe(RAW_SUMMARY);
		expect(executed.summary).toBe("inspect the cache state");
	});

	it("still rejects the stored binding when the committed assistant genuinely changed", async () => {
		const { sessionFile, branch } = sessionFixture();
		residentEntry();
		const { api, handlers } = fakeExtension(branch);
		registerSessionRegistry(api);
		const ctx = context(sessionFile, branch);
		const message = evalAssistant();

		await emit(handlers, "message_update", { message }, ctx);
		await emit(handlers, "message_end", { message }, ctx);
		toolCallOf(message).arguments.code = "return 2";
		branch.push({ type: "message", id: "assistant-entry", message });

		const stored = await readStoredBinding(sessionFile);
		expect(stored).toBeDefined();
		expect(bindingFromStoredBranch(branch, stored!)).toBeUndefined();
	});
});
