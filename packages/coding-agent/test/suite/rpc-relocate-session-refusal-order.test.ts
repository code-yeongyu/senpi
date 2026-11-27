/**
 * senpi#5811: a relocation request refused because its client left must reach the agent as that typed refusal, however
 * long the tool's way back is compared with the close teardown that the same leave starts. On a REAL in-process host the
 * desktop closes the session the moment it is asked. The builtin tool's own way back is today's order (the refusal
 * queued first); a wrapper that hands the result back an explicit number of microtask hops later is the other order (the
 * run's abort would reach the tool body first).
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { nextEvent } from "./rpc-release-host-support.ts";
import { DESKTOP, relocationHost } from "./rpc-relocate-session-host-support.ts";

/** The builtin relocation tools as they are (`hops` 0), or wrapped to take `hops` more microtasks to hand their result back. */
function returningAfter(hops: number): ExtensionFactory {
	if (hops === 0) return relocateSessionExtension;
	return (pi) => {
		const delayed: ExtensionAPI = Object.create(pi);
		delayed.registerTool = (tool) =>
			pi.registerTool({
				...tool,
				execute: async (...args) => {
					const result = await tool.execute(...args);
					for (let hop = 0; hop < hops; hop += 1) await Promise.resolve();
					return result;
				},
			});
		relocateSessionExtension(delayed);
	};
}

describe("a relocation refused by a leaving client, against the close teardown's abort (senpi#5811)", () => {
	it.each([0, 200])("returns the typed refusal when the tool hands its result back %i hops later", async (hops) => {
		// Given: the desktop closes the session as soon as it is asked to move it, and the tool's way back is `hops` long.
		const { host, work, session } = await relocationHost({
			extension: returningAfter(hops),
			answer: (request) =>
				void host.send({ type: "close_session", id: "bye", sessionId: String(request.sessionId) }, DESKTOP),
		});
		await using _host = host;
		const settled = nextEvent(session, "agent_settled");

		// When: the agent asks to move.
		await work();
		await settled;

		// Then: the tool result is the refusal the leave produced, never a generic abort.
		const result = session.messages.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "relocate_session",
		);
		expect(result?.details).toMatchObject({ status: "refused", reason: "app_disconnected" });
	});
});
