import { describe, expect, it } from "vitest";
import {
	ApprovalBridge,
	type AppServerOutboundMessage,
	createAppServerUIContext,
	readSecretQuestionIds,
	redactSecretAnswers,
} from "../../src/modes/app-server/server/approvals.ts";

type SentMessage = {
	readonly threadId: string;
	readonly message: AppServerOutboundMessage;
};

function createSender(sent: SentMessage[], subscriberCount: number) {
	return (threadId: string, message: AppServerOutboundMessage): number => {
		sent.push({ threadId, message });
		return subscriberCount;
	};
}

function isApprovalRequest(
	message: AppServerOutboundMessage,
): message is Extract<AppServerOutboundMessage, { readonly id: number | string }> {
	return "id" in message;
}

describe("app-server approval bridge", () => {
	it("round-trips accept decisions through an id-carrying command approval request", async () => {
		// Given: a bridge with one subscribed client.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));

		// When: command execution approval is requested and the client accepts it.
		const approval = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "echo hello",
			cwd: "/tmp",
		});
		const request = sent[0]?.message;

		expect(request).toMatchObject({
			id: 0,
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "thread-a",
				turnId: "turn-1",
				itemId: "item-1",
				command: "echo hello",
				cwd: "/tmp",
				availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
			},
		});
		expect(bridge.resolveResponse({ id: 0, result: { decision: "accept" } })).toBe(true);

		// Then: the awaiting caller sees an allowed decision.
		await expect(approval).resolves.toEqual({ allow: true, decision: "accept" });
	});

	it("emits resolved notifications through the injected sender when a client responds", async () => {
		// Given: a bridge with one subscribed client and a pending approval.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));
		const approval = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "npm test",
		});

		// When: the client answers the approval request.
		expect(bridge.resolveResponse({ id: 0, result: { decision: "decline", reason: "not now" } })).toBe(true);

		// Then: the same sender seam is used to publish the resolved notification.
		expect(sent).toEqual([
			expect.objectContaining({
				threadId: "thread-a",
				message: expect.objectContaining({
					id: 0,
					method: "item/commandExecution/requestApproval",
				}),
			}),
			{
				threadId: "thread-a",
				message: {
					method: "serverRequest/resolved",
					params: { threadId: "thread-a", requestId: 0 },
				},
			},
		]);
		await expect(approval).resolves.toEqual({ allow: false, decision: "decline", reason: "not now" });
	});

	it("uses first-responder-wins when two fake subscribers answer the same request", async () => {
		// Given: a bridge whose router reaches two subscribers.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 2));

		// When: both clients respond to the same approval request.
		const approval = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "npm test",
		});
		expect(sent).toHaveLength(1);
		expect(bridge.resolveResponse({ id: 0, result: { decision: "accept" } })).toBe(true);
		expect(bridge.resolveResponse({ id: 0, result: { decision: "decline" } })).toBe(false);

		// Then: the first response is the only decision applied.
		await expect(approval).resolves.toEqual({ allow: true, decision: "accept" });
	});

	it("cancels pending approvals on turn end and emits serverRequest/resolved", async () => {
		// Given: a pending approval for a thread.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));
		const approval = bridge.requestApproval("thread-a", "fileChange", {
			turnId: "turn-1",
			itemId: "item-1",
			reason: "write outside workspace",
			grantRoot: "/tmp/project",
		});

		// When: the turn ends before a client responds.
		const cancelled = bridge.cancelPendingForThread("thread-a");

		// Then: the approval resolves as cancel and clients are told the server request is resolved.
		expect(cancelled).toBe(1);
		expect(sent[1]).toEqual({
			threadId: "thread-a",
			message: {
				method: "serverRequest/resolved",
				params: { threadId: "thread-a", requestId: 0 },
			},
		});
		await expect(approval).resolves.toEqual({
			allow: false,
			decision: "cancel",
			reason: "approval request was cancelled because the turn ended",
		});
		expect(bridge.resolveResponse({ id: 0, result: { decision: "accept" } })).toBe(false);
	});

	it("declines immediately when no client is connected to approve", async () => {
		// Given: a bridge whose router reaches no subscribers.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 0));

		// When: approval is requested.
		const approval = await bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "rm -rf /tmp/x",
		});

		// Then: it fails closed without hanging or recording a pending request.
		expect(approval).toEqual({
			allow: false,
			decision: "decline",
			reason: "no client connected to approve",
		});
		expect(sent[0]?.message).toMatchObject({ id: 0, method: "item/commandExecution/requestApproval" });
		expect(bridge.pendingCount).toBe(0);
	});

	it("keeps server request ids independent from client request ids", async () => {
		// Given: a bridge that receives an unrelated client response id.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));

		// When: two server approval requests are created.
		const first = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "one",
		});
		const second = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-2",
			toolName: "bash",
			command: "two",
		});

		// Then: ids are bridge-owned integers starting at zero, and unrelated ids are ignored.
		expect(
			sent
				.map((entry) => entry.message)
				.filter(isApprovalRequest)
				.map((message) => message.id),
		).toEqual([0, 1]);
		expect(bridge.resolveResponse({ id: 99, result: { decision: "accept" } })).toBe(false);
		expect(bridge.resolveResponse({ id: 0, result: { decision: "accept" } })).toBe(true);
		expect(bridge.resolveResponse({ id: 1, result: { decision: "accept" } })).toBe(true);
		await expect(first).resolves.toMatchObject({ allow: true });
		await expect(second).resolves.toMatchObject({ allow: true });
	});

	it("records acceptForSession for identical tool and command in the same thread", async () => {
		// Given: a command allowed for the session.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));
		const first = bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-1",
			itemId: "item-1",
			toolName: "bash",
			command: "git status",
		});
		expect(bridge.resolveResponse({ id: 0, result: { decision: "acceptForSession" } })).toBe(true);
		await expect(first).resolves.toEqual({ allow: true, decision: "acceptForSession" });

		// When: the identical command is requested again for the same thread.
		const second = await bridge.requestApproval("thread-a", "commandExecution", {
			turnId: "turn-2",
			itemId: "item-2",
			toolName: "bash",
			command: "git status",
		});

		// Then: it auto-allows without sending another request.
		expect(second).toEqual({ allow: true, decision: "acceptForSession" });
		expect(sent.filter((entry) => entry.message.method === "item/commandExecution/requestApproval")).toHaveLength(1);
	});

	it("maps permission-system select prompts onto command approval decisions", async () => {
		// Given: a permission-system select prompt for a bash command.
		const sent: SentMessage[] = [];
		const bridge = new ApprovalBridge(createSender(sent, 1));
		const ui = createAppServerUIContext(bridge, "thread-a");

		// When: the client approves the app-server request for the whole session.
		const choicePromise = ui.select("Permission required: bash\n\nCommand: $ npm run check", [
			"Allow once",
			"Allow always",
			"Deny",
			"Deny with feedback",
		]);
		expect(sent[0]?.message).toMatchObject({
			id: 0,
			method: "item/commandExecution/requestApproval",
			params: { command: "npm run check" },
		});
		expect(bridge.resolveResponse({ id: 0, result: { decision: "acceptForSession" } })).toBe(true);

		// Then: the permission-system receives the corresponding option label.
		await expect(choicePromise).resolves.toBe("Allow always");
	});

	it("redacts only secret-marked approval answers", () => {
		// Given: app-server approval questions that include both secret and public command/env-ish answers.
		const secretQuestionIds = readSecretQuestionIds({
			questions: [
				{ id: "api-key", label: "OPENAI_API_KEY", isSecret: true },
				{ id: "token", label: "SENPI_TOKEN", is_secret: true },
				{ id: "command", label: "Command", isSecret: false },
			],
		});

		// When: the client response is redacted before leaving the approval surface.
		const response = redactSecretAnswers(
			{
				answers: {
					"api-key": { answers: ["sk-live-secret"] },
					token: { answers: ["token-secret", "second-secret"] },
					command: { answers: ["npm run check"] },
				},
			},
			secretQuestionIds,
		);

		// Then: only fields marked secret by the copied app-server helper are redacted.
		expect(response).toEqual({
			answers: {
				"api-key": { answers: ["[REDACTED]"] },
				token: { answers: ["[REDACTED]", "[REDACTED]"] },
				command: { answers: ["npm run check"] },
			},
		});
	});
});
