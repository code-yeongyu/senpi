// senpi#6754 (ST, review L1): the session port's write half is a closed protocol contract. A loop commits only what
// `parseSessionEffects` accepted at the remote boundary; every unknown kind, member or shape is refused, and the remote
// ToolHost turns a refusal into the call's error result with nothing committed.
import { createRemoteToolHost, type RemoteSessionPort } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseSessionEffects,
	type SessionEffects,
	SessionEffectsContractError,
} from "../../src/core/hand/session-effects.ts";
import { cleanupHands, openLink, startHandOn } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const VALID: SessionEffects = {
	sent: [
		{
			message: { customType: "note", content: [{ type: "text", text: "hello" }], display: true, details: { a: 1 } },
			options: { triggerTurn: true, deliverAs: "nextTurn" },
		},
	],
	notices: [{ message: "saved", type: "info" }],
	entries: [{ customType: "senpi.todo-state", data: { phases: [] } }],
	userMessages: [{ content: "keep going", options: { deliverAs: "followUp" } }],
	activeTools: { activate: ["tool_search"], deactivate: ["bash"] },
	droppedLate: 2,
};

describe("the session port's write half is a closed contract (senpi#6754)", () => {
	it("reads every kind of a hand's writes exactly", () => {
		expect(parseSessionEffects(JSON.parse(JSON.stringify(VALID)))).toEqual(VALID);
		expect(parseSessionEffects({})).toEqual({});
	});

	it.each([
		["an unknown kind", { wakes: [] }, "unknown members: wakes"],
		["an unknown member of an entry", { entries: [{ customType: "x", id: "forged" }] }, "entries[0] has unknown"],
		["a whole active set instead of a change", { activeTools: ["read"] }, "activeTools is not an object"],
		["a change without its deactivations", { activeTools: { activate: [] } }, "deactivate is not a list"],
		["a notice of an unknown type", { notices: [{ message: "m", type: "fatal" }] }, "type is not one of"],
		[
			"an itemized send",
			{ sent: [{ message: { customType: "x", content: "y", display: true }, options: { items: [] } }] },
			"unknown",
		],
		[
			"a message without its display",
			{ sent: [{ message: { customType: "x", content: "y" } }] },
			"display is not a boolean",
		],
		["a negative drop count", { droppedLate: -1 }, "droppedLate is not a count"],
		["no object at all", ["entries"], "sessionEffects is not an object"],
	])("refuses %s", (_name, value, message) => {
		expect(() => parseSessionEffects(value)).toThrow(SessionEffectsContractError);
		expect(() => parseSessionEffects(value)).toThrow(message);
	});

	it("a call whose writes the contract refuses ends as an error result, and nothing is committed", async () => {
		const link = openLink();
		startHandOn(link, async () => ({
			run: async () => ({
				content: [{ type: "text", text: "ran" }],
				details: {},
				sessionEffects: { activeTools: ["read"] },
			}),
			isSequential: () => false,
			dispose: async () => {},
		}));
		const committed: SessionEffects[] = [];
		const port: RemoteSessionPort<SessionEffects> = {
			carry: () => ({ sessionId: "s", leafId: null, handEntries: [] }),
			parse: parseSessionEffects,
			commit: (_call, effects) => {
				committed.push(effects);
			},
		};
		const host = createRemoteToolHost({ transport: link.brain, placement: "cross-machine", sessionPort: port });

		const { messages } = await host.execute(
			{
				scope: { id: "contract", root: "/work" },
				calls: [{ type: "toolCall", id: "c1", name: "any", arguments: {} }],
				mode: "parallel",
			},
			{ emit: () => {} },
		);
		host.close();

		const [message] = messages;
		expect(message?.isError).toBe(true);
		expect(JSON.stringify(message?.content)).toContain("session writes this session does not accept");
		expect(committed).toEqual([]);
	});
});
