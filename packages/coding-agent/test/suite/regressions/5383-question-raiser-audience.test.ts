// #5383: a broadcast `question` names the connection whose command raised it (`raisedBy`), or "agent" when no
// connection's command started the work; every attached connection still receives it, and select stays targeted.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { createHarness, type Harness } from "../harness.ts";

type Frame = Record<string, unknown>;
type Waiter = { readonly match: (frame: Frame) => boolean; readonly resolve: (frame: Frame) => void };
const routing = "synthetic-routing";
const QUESTION = {
	waitForAnswer: true,
	timeoutMs: 60_000,
	questions: [{ id: "q1", header: "h", question: "?", options: [{ label: "A" }], multiSelect: false }],
};
const ANSWER = { q1: { selected: ["A"] } };

let harness: Harness | undefined;
let handler: RpcConnectionHandler | undefined;

afterEach(async () => {
	await handler?.dispose();
	harness?.cleanup();
	handler = undefined;
	harness = undefined;
});

function fixture(pi: ExtensionAPI): void {
	pi.registerCommand("ask", {
		description: "raise a question from a command",
		handler: async (_args, ctx) => {
			await ctx.ui.question?.({ requestId: "command-question", ...QUESTION });
		},
	});
	pi.registerCommand("pick", {
		description: "raise a select from a command",
		handler: async (_args, ctx) => {
			await ctx.ui.select("pick", ["x"]);
		},
	});
	pi.registerTool({
		name: "ask_probe",
		label: "ask_probe",
		description: "raise a question from a model tool call",
		parameters: Type.Object({}),
		execute: async (toolCallId, _params, _signal, _onUpdate, ctx) => {
			await ctx.ui.question?.({ requestId: toolCallId, ...QUESTION });
			return { content: [{ type: "text", text: "asked" }], details: {} };
		},
	});
}

async function setup() {
	harness = await createHarness({ extensionFactories: [fixture] });
	const writer = new SessionEventWriter(() => {});
	const received = new Map<string, Frame[]>();
	const waiters = new Map<string, Waiter[]>();
	for (const id of ["a", "b"]) {
		const frames: Frame[] = [];
		received.set(id, frames);
		waiters.set(id, []);
		writer.registerConnection(id, {
			writeRaw: (chunk) => {
				for (const line of chunk.split("\n").filter(Boolean)) {
					const frame = JSON.parse(line) as Frame;
					frames.push(frame);
					const pending = waiters.get(id) ?? [];
					const matched = pending.filter((waiter) => waiter.match(frame));
					waiters.set(
						id,
						pending.filter((waiter) => !matched.includes(waiter)),
					);
					for (const waiter of matched) waiter.resolve(frame);
				}
			},
			waitForBackpressure: async () => {},
		});
		writer.setConnectionCapabilities(id, ["question"]);
		writer.attachConnectionToSession(id, routing);
	}
	const runtime = {
		session: harness.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	handler = createRpcConnectionHandler(
		runtime,
		{
			writeRaw: (chunk) => {
				for (const line of chunk.split("\n").filter(Boolean)) writer.enqueue(routing, JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		},
		{
			sessionId: routing,
			disposeRuntime: false,
			capabilities: ["question"],
			clientInfo: {
				connectionId: () => writer.currentConnection(),
				setCapabilities: (id, capabilities) => {
					if (id) writer.setConnectionCapabilities(id, capabilities);
				},
				hasCapability: (id, capability) => writer.getConnectionCapabilities(id)?.includes(capability) === true,
			},
		},
	);
	await handler.ready;
	const active = handler;
	const send = (connection: string, record: Frame) =>
		writer.withConnection(connection, () => active.handleInputLine(JSON.stringify(record)));
	const next = (connection: string, match: (frame: Frame) => boolean): Promise<Frame> => {
		const held = received.get(connection)?.find(match);
		if (held) return Promise.resolve(held);
		return new Promise((resolve) => waiters.get(connection)?.push({ match, resolve }));
	};
	const dialog = (connection: string, method: string) =>
		next(connection, (frame) => frame.type === "extension_ui_request" && frame.method === method);
	return { harness, writer, received, send, next, dialog };
}

it("stamps the raising connection on a command question, delivers it to every attachment and replays it", async () => {
	const { writer, send, next, dialog } = await setup();
	const prompt = send("a", { type: "prompt", id: "p", message: "/ask" });
	const frame = await dialog("a", "question");
	expect(frame.raisedBy).toBe("a");
	expect(await dialog("b", "question")).toEqual(frame);
	const state = next("b", (record) => record.type === "response" && record.command === "get_state");
	await send("b", { type: "get_state", id: "s" });
	expect((await state).data).toMatchObject({ pendingQuestions: [expect.objectContaining({ raisedBy: "a" })] });
	await send("b", { type: "extension_ui_response", id: frame.id, answers: ANSWER });
	await prompt;
	await writer.flush();
});

it("stamps a model tool call's question with the connection whose prompt started the turn", async () => {
	const { harness: current, writer, send, dialog } = await setup();
	current.setResponses([fauxAssistantMessage([fauxToolCall("ask_probe", {})]), fauxAssistantMessage("done")]);
	const prompt = send("a", { type: "prompt", id: "p", message: "go" });
	const frame = await dialog("b", "question");
	expect(frame.raisedBy).toBe("a");
	await send("b", { type: "extension_ui_response", id: frame.id, answers: ANSWER });
	await prompt;
	await writer.flush();
});

it('stamps "agent" on a question raised in a turn that no connection started', async () => {
	const { harness: current, writer, send, dialog } = await setup();
	current.setResponses([fauxAssistantMessage([fauxToolCall("ask_probe", {})]), fauxAssistantMessage("done")]);
	const turn = current.session.prompt("go");
	const frame = await dialog("a", "question");
	expect(frame.raisedBy).toBe("agent");
	expect(await dialog("b", "question")).toEqual(frame);
	await send("a", { type: "extension_ui_response", id: frame.id, answers: ANSWER });
	await turn;
	await writer.flush();
});

it("keeps select targeted at the raising connection, without a raisedBy marker", async () => {
	const { writer, received, send, dialog } = await setup();
	const prompt = send("a", { type: "prompt", id: "p", message: "/pick" });
	const frame = await dialog("a", "select");
	expect(frame).not.toHaveProperty("raisedBy");
	await send("a", { type: "extension_ui_response", id: frame.id, value: "x" });
	await prompt;
	await writer.flush();
	expect(received.get("b")?.some((record) => record.type === "extension_ui_request")).toBe(false);
});
