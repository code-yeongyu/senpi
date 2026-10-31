import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3864: a real RPC question outranks streaming only for the session's root role.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

for (const child of [false, true]) {
	it(`${child ? "excludes a child's" : "reports a root's"} pending question while its tool is streaming`, async () => {
		let fixture: Fixture | undefined;
		const tool: AgentTool = {
			name: "review_question",
			label: "Review",
			description: "Ask for a review",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				const question = fixture?.session.extensionRunner.createContext().ui.question;
				if (!question) throw new Error("The RPC question UI must be bound");
				await question(
					{
						requestId: "review",
						waitForAnswer: true,
						timeoutMs: 60_000,
						questions: [
							{
								id: "choice",
								header: "Review",
								question: "Approve?",
								options: [{ label: "Approve", description: "Approve the result" }],
								multiSelect: false,
							},
						],
					},
					{ signal, timeout: 60_000 },
				);
				return { content: [{ type: "text", text: "Review resolved." }], details: {} };
			},
		};
		fixture = await createIdentityHarness({
			tools: [tool],
			...(child
				? {
						sessionManager: SessionManager.inMemory(undefined, {
							spawnedBy: { parentSessionId: "parent", rootSessionId: "root", taskId: "review" },
						}),
					}
				: {}),
		});
		fixtures.push(fixture);
		await fixture.session.bindExtensions({ mode: "rpc" });
		const client = fixture.bind({ capabilities: ["interactive_user", "question"] });
		await client.send({ type: "set_client_info", capabilities: ["interactive_user", "question"] });
		expect(fixture.session.lifecycle).toBeDefined();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("review_question", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Review incorporated."),
		]);
		const question = client.waitFor(
			(record) => record.type === "extension_ui_request" && record.method === "question",
			10_000,
		);
		const idle = nextSessionEvent(fixture.harness, (event) => event.type === "agent_idle");
		const run = fixture.session.prompt("Ask for the review.");
		const frame = await Promise.race([
			question,
			run.then(() => {
				throw new Error("The turn ended before its question");
			}),
		]);
		expect(fixture.session.isStreaming).toBe(true);
		if (child) {
			expect(fixture.session.lifecycle.role).toBe("child");
			expect(fixture.session.lifecycle.waitingOn?.human).toEqual([]);
			expect(fixture.session.lifecycle.state).not.toBe("waiting_human");
		} else {
			expect(fixture.session.lifecycle).toMatchObject({
				state: "waiting_human",
				waitingOn: { human: [expect.objectContaining({ kind: "question", requestId: "review" })] },
			});
			expect(fixture.session.requestSelfSettle().recorded).toBe(true);
		}
		const revision = fixture.session.lifecycle.humanInputRevision;
		await client.handler.handleInputLine(
			JSON.stringify({
				type: "extension_ui_response",
				id: frame.id,
				...(child ? { cancelled: true } : { answers: { choice: { selected: ["Approve"] } } }),
			}),
		);
		await run;
		await idle;
		if (!child) {
			expect(fixture.session.lifecycle.humanInputRevision).toBe(revision + 1);
			expect(fixture.session.lifecycle.settleDecision).toBeUndefined();
		}
	});
}
