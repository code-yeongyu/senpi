// S33 (brain/hand split, C7c.b; decisions K5, K7): with the loop away from the user's machine (an in-process stand-in
// for a hosted loop host), an unmodified two-sided extension runs whole on the connected user machine: its tool hooks
// run there with the tool, and its loop hooks run there through the loop-hook link, so one state reaches the provider
// request. With that machine offline the request waits, then resumes once.
import {
	createInProcessNetwork,
	createLoopHookHost,
	createReliableTransport,
	createRemoteToolHost,
	type LoopHookHost,
	localEndpoint,
	serveLoopHooks,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEventResult, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createLooplessHandScopes } from "../../src/modes/rpc/remote-executor-scope.ts";
import { cleanupHands, handConfiguration, handDirs, openLink, startHandOn } from "./remote-hand-fixture.ts";

const harnesses: Harness[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

function hookLink() {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `user-machine-${crypto.randomUUID()}`, "/tmp");
	const loop = side();
	const hand = side();
	const stop = network.listen(endpoint, hand);
	const link = network.dial(endpoint, loop);
	link.connect();
	closers.push(() => {
		link.drop();
		stop();
	});
	return { loop, hand, drop: () => link.drop(), connect: () => link.connect() };
}

const noteTool = {
	name: "note",
	label: "note",
	description: "note echoes its input",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id: string, params: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(params) }],
		details: {},
	}),
};

/**
 * Two-sided and unmodified: its tool_result writes state that its next before_agent_start reads into the prompt. The
 * user machine is one process, so its tool host and its hook runner share `machine` (the extension's module state).
 */
const twoSided =
	(machine: { lastResult?: string; loopHookRuns: number }): ExtensionFactory =>
	(pi) => {
		pi.on("tool_result", (event) => {
			machine.lastResult = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			return undefined;
		});
		pi.on("before_agent_start", (event) => {
			machine.loopHookRuns++;
			return machine.lastResult === undefined
				? undefined
				: { systemPrompt: `${event.systemPrompt}\nThe last note said ${machine.lastResult}` };
		});
		pi.registerTool(noteTool);
	};

/** What the loop host loads: the tool's definition only (its catalog), and the forward of its loop hooks. */
const loopHost =
	(host: LoopHookHost, issued: () => void): ExtensionFactory =>
	(pi) => {
		pi.registerTool(noteTool);
		pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult> => {
			issued();
			const reply = (await host.run("before_agent_start", {
				prompt: event.prompt,
				systemPrompt: event.systemPrompt,
			})) as { systemPrompt?: string };
			return reply.systemPrompt === undefined ? {} : { systemPrompt: reply.systemPrompt };
		});
	};

async function hostedSession() {
	const machine = { loopHookRuns: 0 } as { lastResult?: string; loopHookRuns: number };
	const user = await createHarness({ extensionFactories: [twoSided(machine)] });
	harnesses.push(user);
	const tools = openLink();
	const dirs = await handDirs("s33");
	startHandOn(
		tools,
		createLooplessHandScopes(handConfiguration(dirs), {
			extensionFactories: [twoSided(machine)],
			twoSidedHome: "hand",
		}),
	);
	const hooks = hookLink();
	const runner = user.getExtensionRunner();
	const served = serveLoopHooks({
		transport: hooks.hand,
		lane: "loop-hooks",
		run: async (_event, payload) => {
			const { prompt, systemPrompt } = payload as { prompt: string; systemPrompt: string };
			const combined = await runner.emitBeforeAgentStart(prompt, undefined, systemPrompt, { cwd: user.tempDir });
			return JSON.parse(JSON.stringify(combined ?? {})) as JsonValue;
		},
	});
	closers.push(() => served.close());
	const host = createLoopHookHost({ transport: hooks.loop, lane: "loop-hooks" });
	let issued = Promise.withResolvers<void>();
	const loop = await createHarness({ extensionFactories: [loopHost(host, () => issued.resolve())] });
	harnesses.push(loop);
	loop.agent.toolHost = createRemoteToolHost({ transport: tools.brain, placement: "cross-machine" });
	const systemPrompts = () => loop.faux.getCallLog().map((entry) => entry.context.systemPrompt ?? "");
	return {
		machine,
		loop,
		host,
		hooks,
		systemPrompts,
		nextIssue: () => {
			issued = Promise.withResolvers<void>();
			return issued.promise;
		},
	};
}

describe("a two-sided extension's hooks run on the connected user machine (S33, C7c.b, K5)", () => {
	it("its tool_result state on the user machine reaches the next turn's provider request through its loop hook", async () => {
		const session = await hostedSession();
		session.loop.setResponses([
			fauxAssistantMessage([{ ...fauxToolCall("note", { n: 1 }), id: "call-0" }], { stopReason: "toolUse" }),
			fauxAssistantMessage("noted"),
			fauxAssistantMessage("done"),
		]);

		await session.loop.session.prompt("take a note");
		await session.loop.session.prompt("what did it say?");

		expect(session.machine.loopHookRuns).toBe(2);
		expect(session.systemPrompts().at(-1)).toContain('The last note said {"n":1}');
		expect(session.loop.getExtensionRunner().twoSidedExtensionPaths().size).toBe(0);
	});

	it("user machine offline: the request waits with no provider request, then resumes exactly once", async () => {
		const session = await hostedSession();
		session.loop.setResponses([
			fauxAssistantMessage([{ ...fauxToolCall("note", { n: 2 }), id: "call-0" }], { stopReason: "toolUse" }),
			fauxAssistantMessage("noted"),
			fauxAssistantMessage("done"),
		]);
		await session.loop.session.prompt("take a note");
		const before = session.loop.faux.getCallLog().length;
		session.hooks.drop();

		const issued = session.nextIssue();
		const turn = session.loop.session.prompt("what did it say?");
		await issued;

		expect(session.host.waiting()).toHaveLength(1);
		expect(session.loop.faux.getCallLog()).toHaveLength(before);
		expect(session.machine.loopHookRuns).toBe(1);

		session.hooks.connect();
		await turn;

		expect(session.machine.loopHookRuns).toBe(2);
		expect(session.loop.faux.getCallLog()).toHaveLength(before + 1);
		expect(session.systemPrompts().at(-1)).toContain('The last note said {"n":2}');
	});
});
