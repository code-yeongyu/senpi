// S29 (brain/hand split, C7(c), C7c.a, R23.c): an unmodified two-sided extension keeps one state on a split session.
// Its loop hooks run where the loop runs; on the hand its tool_call handlers are forwarded to that same generation over
// the call's nested plane, so a block, an input mutation and state from a loop hook behave exactly as on a fused session.
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createRemoteToolHost } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { EXTENSION_EVENTS_PLANE, serveExtensionEvents } from "../../src/core/extensions/two-sided-forwarding.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { cleanupHands, handDirs, openLink, startHand } from "../hand/remote-hand-fixture.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

/** Two-sided and declaring nothing: state written by a loop hook is read and written into the call by a tool hook. */
const twoSided: ExtensionFactory = (pi) => {
	let prompt: string | undefined;
	pi.on("before_agent_start", (event) => {
		prompt = event.prompt;
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === "guarded") return { block: true, reason: `blocked during ${prompt}` };
		(event.input as Record<string, unknown>).seen = prompt ?? "nothing";
		return undefined;
	});
	for (const name of ["note", "guarded"])
		pi.registerTool({
			name,
			label: name,
			description: `${name} echoes its input`,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
		});
};

/** A hand-local tool hook (no loop events, so it runs on the hand): appends its mark to the call's order. */
const mark =
	(name: string): ExtensionFactory =>
	(pi) => {
		pi.on("tool_call", (event) => {
			const input = event.input as Record<string, unknown>;
			input.order = [...(Array.isArray(input.order) ? input.order : []), name];
			return undefined;
		});
	};

/** Two-sided: marks the order from the loop's process, fails on demand, and rewrites results from loop state. */
const twoSidedMarks: ExtensionFactory = (pi) => {
	let turns = 0;
	pi.on("turn_start", () => {
		turns++;
	});
	pi.on("tool_call", (event) => {
		const input = event.input as Record<string, unknown>;
		if (input.fail === true) throw new Error("two-sided preflight failed");
		input.order = [...(Array.isArray(input.order) ? input.order : []), "two-sided"];
		return undefined;
	});
	pi.on("tool_result", (event) => ({
		content: [...event.content, { type: "text" as const, text: ` after turn ${turns}` }],
	}));
	pi.registerTool({
		name: "note",
		label: "note",
		description: "note echoes its input",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
	});
};

/** Two-sided, with a `runs: "hand"` tool hook between two undeclared ones; each mark names the copy that ran it. */
const mixedSides =
	(copy: string): ExtensionFactory =>
	(pi) => {
		const markAs = (name: string) => (event: { input: unknown }) => {
			const input = event.input as Record<string, unknown>;
			input.order = [...(Array.isArray(input.order) ? input.order : []), `${name}@${copy}`];
			return undefined;
		};
		pi.on("turn_start", () => undefined);
		pi.on("tool_call", markAs("first"));
		pi.on("tool_call", markAs("declared"), { runs: "hand" });
		pi.on("tool_call", markAs("second"));
		pi.registerTool({
			name: "note",
			label: "note",
			description: "note echoes its input",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
		});
	};

async function resultsOf(
	placement: "fused" | "split-local",
	calls: readonly [string, JsonObject][],
	factories: readonly ExtensionFactory[] = [twoSided],
	brainFactories: readonly ExtensionFactory[] = factories,
): Promise<string[]> {
	const harness = await createHarness({ extensionFactories: [...brainFactories] });
	harnesses.push(harness);
	if (placement === "split-local") {
		const dirs = await handDirs("s29");
		const link = openLink();
		startHand(link, dirs, [...factories]);
		harness.agent.toolHost = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: { [EXTENSION_EVENTS_PLANE]: serveExtensionEvents(harness.getExtensionRunner()) },
		});
	}
	harness.setResponses([
		fauxAssistantMessage(
			calls.map(([name, args], index) => ({ ...fauxToolCall(name, args), id: `call-${index}` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					`${message.isError ? "error" : "ok"} ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
				]
			: [],
	);
}

describe("a two-sided extension on a split session behaves as fused (S29)", () => {
	it("a tool_call mutation that reads loop-hook state reaches the tool on the hand", async () => {
		const calls: [string, JsonObject][] = [["note", { n: 1 }]];
		const fused = await resultsOf("fused", calls);

		expect(await resultsOf("split-local", calls)).toEqual(fused);
		expect(fused).toEqual(['ok {"n":1,"seen":"go"}']);
	});

	it("a forwarded block stops the body, in order with the calls around it", async () => {
		const calls: [string, JsonObject][] = [
			["note", { n: 1 }],
			["guarded", { n: 2 }],
			["note", { n: 3 }],
		];

		expect(await resultsOf("split-local", calls)).toEqual(await resultsOf("fused", calls));
	});

	it("keeps registration order with hand-local hooks around the forwarded one", async () => {
		const factories = [mark("before"), twoSidedMarks, mark("after")];
		const calls: [string, JsonObject][] = [["note", { n: 1 }]];
		const fused = await resultsOf("fused", calls, factories);

		expect(await resultsOf("split-local", calls, factories)).toEqual(fused);
		expect(fused).toEqual(['ok {"n":1,"order":["before","two-sided","after"]} after turn 1']);
	});

	it("forwards each undeclared handler and keeps a declared hand handler on the hand, in order", async () => {
		const calls: [string, JsonObject][] = [["note", { n: 1 }]];

		const split = await resultsOf("split-local", calls, [mixedSides("hand")], [mixedSides("loop")]);

		expect(split).toEqual(['ok {"n":1,"order":["first@loop","declared@hand","second@loop"]}']);
	});

	it("fails the call closed when a forwarded preflight throws, as fused does", async () => {
		const calls: [string, JsonObject][] = [
			["note", { fail: true }],
			["note", { n: 2 }],
		];
		const fused = await resultsOf("fused", calls, [twoSidedMarks]);

		expect(await resultsOf("split-local", calls, [twoSidedMarks])).toEqual(fused);
		expect(fused[0]).toMatch(/^error .*two-sided preflight failed/);
	});

	it("fails the call closed when the loop's process does not have the forwarded extension", async () => {
		const ran: string[] = [];
		const counted: ExtensionFactory = (pi) => {
			twoSided(pi);
			pi.registerTool({
				name: "counted",
				label: "counted",
				description: "records that it ran",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async () => {
					ran.push("counted");
					return { content: [{ type: "text", text: "ran" }], details: {} };
				},
			});
		};
		const toolOnly: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "counted",
				label: "counted",
				description: "records that it ran",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async () => ({ content: [{ type: "text", text: "brain" }], details: {} }),
			});
		};

		const results = await resultsOf("split-local", [["counted", {}]], [counted], [toolOnly]);

		expect(results[0]).toMatch(/^error .*not loaded where the loop runs/);
		expect(ran).toEqual([]);
	});
});
