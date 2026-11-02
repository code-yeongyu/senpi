import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { HumanInputAdmittedEvent } from "../../../src/core/agent-session.ts";
import { deliverAnswer } from "../../../src/core/extensions/builtin/ask-user/tool.ts";
import type { ExtensionAPI, ExtensionContext, QuestionRequest } from "../../../src/core/extensions/types.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3864: a person's answer over RPC `extension_ui_response` is reported as human input exactly once.
// A tool-result answer is reported by the RPC adapter; an async or resumed answer is delivered as a user
// message, whose question-input release reports it (ask-user `deliverAnswer`), so the adapter must stay silent.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

const cases = [
	{ name: "an async question", waitForAnswer: false, deliver: "user-message", deliveredAsMessage: true },
	{ name: "a resumed question", waitForAnswer: true, deliver: "user-message", deliveredAsMessage: true },
	{ name: "a tool-result question", waitForAnswer: true, deliver: "tool-result", deliveredAsMessage: false },
] as const;

for (const testCase of cases) {
	it(`reports ${testCase.name}'s RPC answer exactly once`, async () => {
		let api: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					api = pi;
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		fixtures.push(fixture);
		await fixture.session.bindExtensions({ mode: "rpc" });
		const seen: HumanInputAdmittedEvent["kind"][] = [];
		fixture.session.onHumanInputAdmitted((event) => seen.push(event.kind));
		const client = fixture.bind({ capabilities: ["interactive_user", "question"] });
		await client.send({ type: "set_client_info", capabilities: ["interactive_user", "question"] });
		const question = fixture.session.extensionRunner.createContext().ui.question;
		if (!question || context === undefined || api === undefined) throw new Error("The RPC question UI must be bound");
		const revision = fixture.session.lifecycle.humanInputRevision;
		const questionRequest: QuestionRequest = {
			requestId: "choice",
			waitForAnswer: testCase.waitForAnswer,
			timeoutMs: 60_000,
			questions: [
				{
					id: "choice",
					header: "Choice",
					question: "Ship it?",
					options: [{ label: "Yes", description: "Ship" }],
					multiSelect: false,
				},
			],
		};
		const frame = client.waitFor(
			(record) => record.type === "extension_ui_request" && record.method === "question",
			10_000,
		);

		const answered = question(questionRequest, { timeout: 60_000, deliver: testCase.deliver });
		const request = await frame;
		await client.handler.handleInputLine(
			JSON.stringify({ type: "extension_ui_response", id: request.id, answers: { choice: { selected: ["Yes"] } } }),
		);
		const response = await answered;
		expect(response.status).toBe("answered");
		if (testCase.deliveredAsMessage) {
			fixture.harness.setResponses([fauxAssistantMessage("Answer received.")]);
			const idle = nextSessionEvent(fixture.harness, (event) => event.type === "agent_idle");
			deliverAnswer(api, context, questionRequest, response, "codex");
			await idle;
			expect(fixture.session.lifecycle.epochOrigin).toBe("human");
		}

		expect(seen).toEqual(["answer"]);
		expect(fixture.session.lifecycle.humanInputRevision).toBe(revision + 1);
	});
}
