import type { Agent } from "../../src/agent.ts";
import { call, echo, type Scenario } from "./prepared-parity-fixture.ts";

const abortOn =
	(name: string) =>
	(agent: Agent): void => {
		agent.beforeToolCall = async ({ toolCall }) => {
			if (toolCall.name === name) agent.abort();
			return undefined;
		};
	};

// One scenario per path the loop's own scheduler handles (agent-loop.ts executeToolCalls*), named by that path.
export const scenarios: Readonly<Record<string, Scenario>> = {
	"parallel batch with updates": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "echo", { n: 1 })],
		expected: {
			starts: ["c0 echo", "c1 echo"],
			calls: { c0: "start update end msg", c1: "start update end msg" },
			results: ['c0 echo ok {"n":0}', 'c1 echo ok {"n":1}'],
			turns: 2,
		},
	},
	"sequential tool as a barrier in a parallel batch": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "serial", { n: 1 }), call("c2", "echo", { n: 2 })],
		expected: {
			starts: ["c0 echo", "c1 serial", "c2 echo"],
			calls: { c0: "start update end msg", c1: "start update end msg", c2: "start update end msg" },
			results: ['c0 echo ok {"n":0}', 'c1 serial ok {"n":1}', 'c2 echo ok {"n":2}'],
			turns: 2,
		},
	},
	"whole batch in sequential mode": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "echo", { n: 1 })],
		setup: (agent) => {
			agent.toolExecution = "sequential";
		},
		expected: {
			starts: ["c0 echo", "c1 echo"],
			calls: { c0: "start update end msg", c1: "start update end msg" },
			results: ['c0 echo ok {"n":0}', 'c1 echo ok {"n":1}'],
			turns: 2,
		},
	},
	"incomplete call next to a complete one": {
		calls: [
			call("c0", "echo", { n: 0 }, { incomplete: true, errorMessage: "cut off" }),
			call("c1", "echo", { n: 1 }),
		],
		expected: {
			starts: ["c0 echo", "c1 echo"],
			calls: { c0: "start end! msg", c1: "start update end msg" },
			results: ["c0 echo error cut off. Re-issue the tool call with complete arguments.", 'c1 echo ok {"n":1}'],
			turns: 2,
		},
	},
	"unknown tool without and with a removed-tool hint": {
		calls: [call("c0", "missing"), call("c1", "gone")],
		setup: (agent) => {
			agent.removedToolHints = { gone: "Use echo instead." };
		},
		expected: {
			starts: ["c0 missing", "c1 gone"],
			calls: { c0: "start end! msg", c1: "start end! msg" },
			results: ["c0 missing error Tool missing not found", "c1 gone error Tool gone not found. Use echo instead."],
			turns: 2,
		},
	},
	"lazy tool activated by resolveUnknownToolCall": {
		calls: [call("c0", "lazy", { n: 0 })],
		setup: (agent) => {
			agent.resolveUnknownToolCall = (name) => (name === "lazy" ? { ...echo, name: "lazy" } : undefined);
		},
		expected: {
			starts: ["c0 lazy"],
			calls: { c0: "start update end msg" },
			results: ['c0 lazy ok {"n":0}'],
			turns: 2,
		},
	},
	"alias resolved to a tool that runs": {
		calls: [call("c0", "Echo", { n: 0 })],
		expected: {
			starts: ["c0 echo"],
			calls: { c0: "start update end msg" },
			results: [
				'c0 echo ok [auto-corrected] no tool is named "Echo"; ran "echo". Call tools by their exact listed name.{"n":0}',
			],
			turns: 2,
		},
	},
	"blocked call, blocked alias and a terminate block": {
		calls: [call("c0", "serial", { n: 0 }), call("c1", "Serial", { n: 1 }), call("c2", "echo", { n: 2 })],
		setup: (agent) => {
			agent.beforeToolCall = async ({ toolCall }) =>
				toolCall.name === "serial"
					? { block: true, reason: "no serial", terminate: toolCall.id === "c1" }
					: undefined;
		},
		expected: {
			starts: ["c0 serial", "c1 serial", "c2 echo"],
			calls: { c0: "start end! msg", c1: "start end! msg", c2: "start update end msg" },
			results: [
				"c0 serial error no serial",
				'c1 serial error [auto-corrected] no tool is named "Serial"; ran "serial". Call tools by their exact listed name.no serial',
				'c2 echo ok {"n":2}',
			],
			turns: 2,
		},
	},
	"every call blocked with terminate ends the batch": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "echo", { n: 1 })],
		setup: (agent) => {
			agent.beforeToolCall = async () => ({ block: true, reason: "stop", terminate: true });
		},
		expected: {
			starts: ["c0 echo", "c1 echo"],
			calls: { c0: "start end! msg", c1: "start end! msg" },
			results: ["c0 echo error stop", "c1 echo error stop"],
			turns: 1,
		},
	},
	"argument validation error": {
		calls: [call("c0", "strict", {})],
		expected: {
			starts: ["c0 strict"],
			calls: { c0: "start end! msg" },
			results: [
				'c0 strict error Validation failed for tool "strict":\n  - path: must have required properties path\n\nReceived arguments:\n{}',
			],
			turns: 2,
		},
	},
	"body throws": {
		calls: [call("c0", "boom"), call("c1", "echo", { n: 1 })],
		expected: {
			starts: ["c0 boom", "c1 echo"],
			calls: { c0: "start end! msg", c1: "start update end msg" },
			results: ["c0 boom error boom failed", 'c1 echo ok {"n":1}'],
			turns: 2,
		},
	},
	"result with terminate ends the batch": {
		calls: [call("c0", "stopper")],
		expected: {
			starts: ["c0 stopper"],
			calls: { c0: "start end msg" },
			results: ["c0 stopper ok stop here"],
			turns: 1,
		},
	},
	"afterToolCall overrides the result": {
		calls: [call("c0", "echo", { n: 0 })],
		setup: (agent) => {
			agent.afterToolCall = async () => ({ content: [{ type: "text", text: "rewritten" }], isError: true });
		},
		expected: {
			starts: ["c0 echo"],
			calls: { c0: "start update end! msg" },
			results: ["c0 echo error rewritten"],
			turns: 2,
		},
	},
	"afterToolCall throws": {
		calls: [call("c0", "echo", { n: 0 })],
		setup: (agent) => {
			agent.afterToolCall = async () => {
				throw new Error("after failed");
			};
		},
		expected: {
			starts: ["c0 echo"],
			calls: { c0: "start update end! msg" },
			results: ["c0 echo error after failed"],
			turns: 2,
		},
	},
	"abort inside beforeToolCall in a parallel batch": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "serial", { n: 1 }), call("c2", "echo", { n: 2 })],
		setup: abortOn("serial"),
		expected: {
			starts: ["c0 echo", "c1 serial"],
			calls: { c0: "start end! msg", c1: "start end! msg" },
			results: ["c0 echo error Operation aborted", "c1 serial error Operation aborted"],
			turns: 1,
		},
	},
	"abort inside beforeToolCall in sequential mode": {
		calls: [call("c0", "echo", { n: 0 }), call("c1", "serial", { n: 1 }), call("c2", "echo", { n: 2 })],
		setup: (agent) => {
			agent.toolExecution = "sequential";
			abortOn("serial")(agent);
		},
		expected: {
			starts: ["c0 echo", "c1 serial"],
			calls: { c0: "start update end msg", c1: "start end! msg" },
			results: ['c0 echo ok {"n":0}', "c1 serial error Operation aborted"],
			turns: 1,
		},
	},
	"abort while a body never settles": {
		calls: [call("c0", "hang"), call("c1", "echo", { n: 1 })],
		setup: (agent) => {
			agent.state.tools = [
				...agent.state.tools,
				{
					...echo,
					name: "hang",
					execute: () => {
						agent.abort();
						return new Promise(() => undefined);
					},
				},
			];
		},
		expected: {
			starts: ["c0 hang", "c1 echo"],
			calls: { c0: "start end! msg", c1: "start end! msg" },
			results: ["c0 hang error Tool execution aborted", "c1 echo error Operation aborted"],
			turns: 1,
		},
	},
};
