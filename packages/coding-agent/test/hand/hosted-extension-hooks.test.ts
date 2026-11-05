// S33 (brain/hand split, C7c.b; decisions K5, K7): with the loop away from the user's machine (an in-process stand-in
// for a hosted loop host), the unmodified two-sided closure-ext fixture (loaded by path, as S29 loads it) runs whole on
// the connected user machine: its tool hooks run there with the tool, and its loop hook runs there too, in the same
// extension instance, so one closure reaches the provider request exactly as on a fused session. Nothing is shared
// in-process between the loop host and the user machine. With that machine offline the request waits, then resumes once.
import { fileURLToPath } from "node:url";
import {
	type AgentTool,
	type ExecutionScope,
	createInProcessNetwork,
	createLoopHookHost,
	createReliableTransport,
	createRemoteToolHost,
	type LoopHookHost,
	localEndpoint,
	serveLoopHooks,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import type { BeforeAgentStartEventResult, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { cleanupHands, handConfiguration, handDirs, openLink, startHandOn } from "./remote-hand-fixture.ts";

const closureExt = fileURLToPath(new URL("../fixtures/closure-ext/index.ts", import.meta.url));

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

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo the arguments back",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
};
const echoOnHand: ExtensionFactory = (pi) => {
	pi.registerTool(echo);
};

/** The loop host's only extension: its before_agent_start waits for the user machine and applies what came back. */
const forwardLoopHooks =
	(host: LoopHookHost, scope: () => ExecutionScope, issued: () => void, errors: string[]): ExtensionFactory =>
	(pi) => {
		pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult> => {
			issued();
			const { id, root } = scope();
			const reply = (await host
				.run("before_agent_start", {
					prompt: event.prompt,
					systemPrompt: event.systemPrompt,
					trigger: event.trigger,
					...(event.preview === undefined ? {} : { preview: event.preview }),
					systemPromptOptions: JSON.parse(JSON.stringify(event.systemPromptOptions)) as JsonValue,
					idle: ctx.isIdle(),
					sessionId: ctx.sessionManager.getSessionId(),
					scope: { id, root },
				})
				.catch((error: unknown) => {
					errors.push(error instanceof Error ? error.message : String(error));
					throw error;
				})) as { systemPrompt?: string; errors?: { extensionPath: string; error: string }[] };
			for (const failed of reply.errors ?? []) errors.push(`${failed.extensionPath}: ${failed.error}`);
			return reply.systemPrompt === undefined ? {} : { systemPrompt: reply.systemPrompt };
		});
	};

const closureLine = (systemPrompt: string): string =>
	systemPrompt.split("\n").find((line) => line.startsWith("closure-ext ")) ?? "<missing>";

interface Trace {
	readonly toolText: string;
	readonly providerClosureLines: string[];
}

const turns = (lines: string[]): FauxResponseStep[] => [
	(context) => {
		lines.push(closureLine(getCurrentSystemPrompt(context.messages)));
		return fauxAssistantMessage([fauxToolCall("echo", { n: 0 })], { stopReason: "toolUse" });
	},
	fauxAssistantMessage("turn one done"),
	(context) => {
		lines.push(closureLine(getCurrentSystemPrompt(context.messages)));
		return fauxAssistantMessage("turn two done");
	},
];

async function fusedTrace(): Promise<Trace> {
	const extensionsResult = await loadExtensions([closureExt], process.cwd());
	const fused = await createHarness({ tools: [echo], resourceLoader: createTestResourceLoader({ extensionsResult }) });
	harnesses.push(fused);
	const providerClosureLines: string[] = [];
	fused.setResponses(turns(providerClosureLines));
	await fused.session.prompt("call echo");
	const toolText = getToolResult(fused, "echo")
		.content.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	await fused.session.prompt("what did the tool see?");
	return { toolText, providerClosureLines };
}

/**
 * The user machine: one hand whose scope runtime loads closure-ext by path and serves both the tool calls (remote
 * executor) and the loop hooks (loop-hook link). The loop host loads nothing of the extension.
 */
async function hostedSession() {
	const tools = openLink();
	const dirs = await handDirs("s33");
	const hand = createLooplessHand(handConfiguration(dirs, ["-e", closureExt]), {
		extensionFactories: [echoOnHand],
		twoSidedHome: "hand",
	});
	startHandOn(tools, hand.openScope);
	const hooks = hookLink();
	const served = serveLoopHooks({
		transport: hooks.hand,
		lane: "loop-hooks",
		run: hand.loopHooks,
	});
	closers.push(() => served.close());
	const host = createLoopHookHost({ transport: hooks.loop, lane: "loop-hooks" });
	let issued = Promise.withResolvers<void>();
	const hookErrors: string[] = [];
	let loop: Harness | undefined;
	const scope = (): ExecutionScope => {
		if (loop === undefined) throw new Error("the loop host is not built yet");
		return loop.agent.getExecutionScope?.() ?? loop.agent.executionScope;
	};
	loop = await createHarness({
		tools: [echo],
		extensionFactories: [forwardLoopHooks(host, scope, () => issued.resolve(), hookErrors)],
	});
	const session = loop;
	harnesses.push(session);
	session.agent.toolHost = createRemoteToolHost({ transport: tools.brain, placement: "cross-machine" });
	const providerClosureLines: string[] = [];
	session.setResponses(turns(providerClosureLines));
	return {
		loop: session,
		hookErrors,
		host,
		hooks,
		providerClosureLines,
		nextIssue: () => {
			issued = Promise.withResolvers<void>();
			return issued.promise;
		},
		toolText: () =>
			getToolResult(session, "echo")
				.content.map((part) => (part.type === "text" ? part.text : ""))
				.join(""),
	};
}

describe("an unmodified two-sided extension runs whole on the connected user machine (S33, C7c.b, K5)", () => {
	it("its tool_result closure state reaches the next turn's provider request, exactly as fused", async () => {
		const fused = await fusedTrace();
		const session = await hostedSession();

		await session.loop.session.prompt("call echo");
		const toolText = session.toolText();
		await session.loop.session.prompt("what did the tool see?");

		expect(session.hookErrors).toEqual([]);
		expect(fused).toEqual({
			toolText: '{"n":1}',
			providerClosureLines: ["closure-ext turn=1 lastResultN=none", "closure-ext turn=2 lastResultN=1"],
		});
		expect({ toolText, providerClosureLines: session.providerClosureLines }).toEqual(fused);
		expect(session.loop.getExtensionRunner().getExtensionPaths()).not.toContain(closureExt);
	});

	it("user machine offline: the request waits with no provider request, then resumes exactly once", async () => {
		const fused = await fusedTrace();
		const session = await hostedSession();
		await session.loop.session.prompt("call echo");
		const toolText = session.toolText();
		const before = session.loop.faux.getCallLog().length;
		session.hooks.drop();

		const issued = session.nextIssue();
		const turn = session.loop.session.prompt("what did the tool see?");
		await issued;

		expect(session.host.waiting()).toHaveLength(1);
		expect(session.loop.faux.getCallLog()).toHaveLength(before);

		session.hooks.connect();
		await turn;

		expect(session.hookErrors).toEqual([]);
		expect(session.loop.faux.getCallLog()).toHaveLength(before + 1);
		expect({ toolText, providerClosureLines: session.providerClosureLines }).toEqual(fused);
	});
});
