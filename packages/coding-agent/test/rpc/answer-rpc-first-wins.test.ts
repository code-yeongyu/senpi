/**
 * C5.b (S26a): an extension UI request is answered over RPC by whoever answers first - the client that sees the
 * dialog, or another session or agent on its own connection - and every later answer is refused without settling
 * anything. The race is forced in both orders: across two host connections, and inside the winner's admission
 * step (`beforeAnswer`), where a competing answer arrives before the winner has settled the request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { answerExtensionUiResponse, type AnswerTargets } from "../../src/modes/rpc/handlers-answer.ts";
import type { RpcExtensionUIResponse } from "../../src/modes/rpc/rpc-types.ts";
import { SessionExtensionUiRequests } from "../../src/modes/rpc/session-extension-ui-requests.ts";
import { UiAnswerLedger } from "../../src/modes/rpc/ui-answer-ledger.ts";
import type { WorkerHostRecord } from "../suite/rpc-host-endpoint.ts";
import { startInProcessHost } from "../suite/rpc-worker-host-support.ts";

const EXTENSION = `export default function (pi) {
	pi.registerCommand("ask-input", { description: "input fixture", handler: async (args, ctx) => {
		const value = await ctx.ui.input("Name " + args + "?");
		ctx.ui.notify("input:" + args + ":" + value);
	} });
}`;
const WAIT_MS = 10_000;

type Host = Awaited<ReturnType<typeof startInProcessHost>>;
type Client = Awaited<ReturnType<Host["connect"]>>;

const hosts: Host[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose();
	vi.unstubAllEnvs();
});

const isReply = (id: string) => (record: WorkerHostRecord) =>
	record.type === "response" && record.command === "extension_ui_response" && record.id === id;
const isNotice = (prefix: string) => (record: WorkerHostRecord) =>
	record.type === "extension_ui_request" &&
	record.method === "notify" &&
	typeof record.message === "string" &&
	record.message.startsWith(prefix);

async function answer(client: Client, frame: Record<string, unknown> & { id: string }) {
	const replied = client.wait(isReply(frame.id), WAIT_MS);
	client.send({ type: "extension_ui_response", ...frame });
	return replied;
}

describe("C5.b: the first RPC answer wins", () => {
	it.each([
		{ order: "client first", first: "client", second: "agent" },
		{ order: "another agent first", first: "agent", second: "client" },
	] as const)(
		"across two connections, $order: one answer settles the dialog, the other is refused",
		async ({ first, second }) => {
			// Given: a session blocked on an input dialog, seen by its client, and a second connection (another agent)
			vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
			const host = await startInProcessHost(EXTENSION);
			hosts.push(host);
			const connections = { client: await host.connect(), agent: await host.connect() };
			const opened = await connections.client.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			if (sessionId === undefined) throw new Error("open_session returned no sessionId");
			const asked = connections.client.wait(
				(record) => record.type === "extension_ui_request" && record.method === "input",
				WAIT_MS,
			);
			const prompt = connections.client.request({ type: "prompt", sessionId, message: "/ask-input race" });
			const uiRequestId = (await asked).id;
			if (uiRequestId === undefined) throw new Error("input request without an id");
			const notice = connections.client.wait(isNotice("input:race:"), WAIT_MS);

			// When: both answer, in the forced order
			const won = await answer(connections[first], {
				sessionId,
				id: `frame-${first}`,
				uiRequestId,
				answerId: `answer-${first}`,
				value: first,
			});
			const lost = await answer(connections[second], {
				sessionId,
				id: `frame-${second}`,
				uiRequestId,
				answerId: `answer-${second}`,
				value: second,
			});

			// Then: the first is applied and the dialog resolves with its value, the second is refused
			expect(won).toMatchObject({ id: `frame-${first}`, success: true, disposition: "applied" });
			expect(lost).toMatchObject({
				id: `frame-${second}`,
				success: false,
				error: "already_answered",
				disposition: "already_answered",
			});
			expect((await notice).message).toBe(`input:race:${first}`);
			expect((await prompt).success).toBe(true);
			expect(connections.client.records.filter(isNotice("input:"))).toHaveLength(1);
		},
		120_000,
	);

	it("an answer that arrives while the winner is being admitted settles nothing", () => {
		// Given: a pending input dialog and a barrier inside the winner's admission step
		const dialogs = new SessionExtensionUiRequests();
		const resolved: RpcExtensionUIResponse[] = [];
		dialogs.set("ask", { resolve: (response) => resolved.push(response), reject: () => {} });
		const replies: unknown[] = [];
		const targets = (beforeAnswer: () => void): AnswerTargets => ({
			secretInputs: {
				has: () => false,
				respond: () => ({ id: "", type: "response", command: "extension_ui_response", success: true }),
			},
			grantRequests: new Map(),
			workerSecurityBridge: false,
			sender: undefined,
			grantCapable: () => false,
			questions: { respond: () => false },
			dialogs,
			routed: true,
			ledger: new UiAnswerLedger(),
			beforeAnswer,
		});
		const competing = { type: "extension_ui_response", id: "ask", value: "competing" } as const;

		// When: the winner is being admitted and the competing answer arrives
		const winner = answerExtensionUiResponse(
			{ type: "extension_ui_response", id: "ask", value: "winner" },
			targets(() =>
				replies.push(
					answerExtensionUiResponse(
						competing,
						targets(() => {}),
					),
				),
			),
		);

		// Then: the winner settles the dialog once with its own value; the competing answer is refused
		expect(winner).toMatchObject({ success: true, disposition: "applied" });
		expect(replies).toEqual([expect.objectContaining({ success: false, error: "unknown_extension_ui_request" })]);
		expect(resolved).toEqual([{ type: "extension_ui_response", id: "ask", value: "winner" }]);
	});

	it("a claim whose admission throws is released, so the next answer still settles the dialog", () => {
		// Given: a pending dialog whose first answer's admission throws
		const dialogs = new SessionExtensionUiRequests();
		const resolved: RpcExtensionUIResponse[] = [];
		dialogs.set("ask", { resolve: (response) => resolved.push(response), reject: () => {} });
		const failing = () => {
			throw new Error("admission failed");
		};

		// When: the failing answer is tried, then another one
		expect(() => dialogs.resolve({ type: "extension_ui_response", id: "ask", value: "first" }, failing)).toThrow(
			"admission failed",
		);
		const settled = dialogs.resolve({ type: "extension_ui_response", id: "ask", value: "second" });

		// Then: the dialog stayed pending and the second answer settles it
		expect(settled).toBe(true);
		expect(resolved).toEqual([{ type: "extension_ui_response", id: "ask", value: "second" }]);
	});

	it("a cancel that runs while the winner is being admitted settles the dialog first", () => {
		// Given: a pending dialog
		const dialogs = new SessionExtensionUiRequests();
		const resolved: RpcExtensionUIResponse[] = [];
		dialogs.set("ask", { resolve: (response) => resolved.push(response), reject: () => {} });

		// When: the session cancels its dialogs inside the answer's admission step
		const settled = dialogs.resolve({ type: "extension_ui_response", id: "ask", value: "late" }, () =>
			dialogs.cancelAll(),
		);

		// Then: the answer reports it settled nothing, and the dialog resolved once, as cancelled
		expect(settled).toBe(false);
		expect(resolved).toEqual([{ type: "extension_ui_response", id: "ask", cancelled: true }]);
	});

	it("a question answer that arrives while the winner is being admitted settles nothing", async () => {
		// Given: a blocking question and a barrier inside the winner's admission step
		const frames: Array<{ id?: string }> = [];
		const bridge = new ConnectionQuestionBridge((record) => frames.push(record));
		const request: QuestionRequest = {
			requestId: "call-1",
			waitForAnswer: true,
			timeoutMs: 60_000,
			questions: [
				{
					id: "q",
					header: "Pick",
					question: "Pick one",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: false,
				},
			],
		};
		const asked: Promise<QuestionResponse> = bridge.ask(request);
		const id = frames[0]?.id;
		if (id === undefined) throw new Error("question frame without an id");
		const competing: unknown[] = [];

		// When: the winner answers A, and B arrives during its admission
		const winner = bridge.respond({ type: "extension_ui_response", id, answers: { q: { selected: ["A"] } } }, () =>
			competing.push(bridge.respond({ type: "extension_ui_response", id, answers: { q: { selected: ["B"] } } })),
		);

		// Then: A settles the question; B is refused as already resolved
		expect(winner).toBe(true);
		expect(competing).toEqual(["question_already_resolved"]);
		expect(await asked).toMatchObject({ status: "answered", answers: { q: { selected: ["A"] } } });
	});
});
