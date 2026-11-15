// senpi#6754 (ST, review L1): the session port's write half is a closed protocol contract. A loop commits only what
// `parseSessionEffects` accepted at the remote boundary; every unknown kind, member or shape is refused, and the remote
// ToolHost turns a refusal into the call's error result with nothing committed.
import { createRemoteToolHost, type RemoteSessionPort } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyActiveToolsChange,
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
	documents: { "extensions/goal/s.json": "{}", "extensions/loop/s.json": null },
	wakes: [
		{
			op: "arm",
			wake: {
				id: "loop:l1",
				source: "schedule_wakeup",
				dueAt: 2,
				prompt: "/loop go",
				createdAt: 1,
				entry: { customType: "loop-tick", data: { loopId: "l1" } },
			},
		},
		{ op: "cancel", id: "sch_000000000000" },
	],
	relocation: { target: "studio", reason: "heavier build", moveId: "m1" },
};

const wake = { id: "w", source: "schedule_prompt", dueAt: 2, prompt: "p", createdAt: 1 };

describe("the session port's write half is a closed contract (senpi#6754)", () => {
	it("reads every kind of a hand's writes exactly", () => {
		expect(parseSessionEffects(JSON.parse(JSON.stringify(VALID)))).toEqual(VALID);
		expect(parseSessionEffects({})).toEqual({});
	});

	it.each([
		["an unknown kind", { timers: [] }, "unknown members: timers"],
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
		["a drop count (late writes travel as wakes)", { droppedLate: 1 }, "unknown members: droppedLate"],
		["a tool activated twice", { activeTools: { activate: ["a", "a"], deactivate: [] } }, "names a twice"],
		// A wake is the schedule and what to run: anything else, a key or token included, has no place in it.
		[
			"a wake carrying a key",
			{ wakes: [{ op: "arm", wake: { ...wake, sessionKey: "k" } }] },
			"unknown members: sessionKey",
		],
		[
			"a wake of another tool",
			{ wakes: [{ op: "arm", wake: { ...wake, source: "bash" } }] },
			"not a scheduling tool",
		],
		["a document outside the session", { documents: { "../agent/auth.json": "x" } }, "outside the session"],
		["a move without its id", { relocation: { target: "studio", reason: "r" } }, "moveId is not text"],
		["no object at all", ["entries"], "sessionEffects is not an object"],
	])("refuses %s", (_name, value, message) => {
		expect(() => parseSessionEffects(value)).toThrow(SessionEffectsContractError);
		expect(() => parseSessionEffects(value)).toThrow(message);
	});

	it("applies a change to the current set once per name, whatever the current set repeats", () => {
		expect(
			applyActiveToolsChange(["read", "read", "bash"], { activate: ["todo", "read"], deactivate: ["bash"] }),
		).toEqual(["read", "todo"]);
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
			sessionId: () => "s",
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
