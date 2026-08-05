import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AutoClassifierInput,
	buildAutoClassifierContext,
	runAutoClassifier,
} from "../../src/core/extensions/builtin/permission-system/auto-classifier.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const history: Message[] = [
	{ role: "user", content: "Update the parser and push the branch.", timestamp: 1 },
	fauxAssistantMessage("PRIVATE ASSISTANT REASONING"),
	{
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }],
		isError: false,
		timestamp: 2,
	} as Message,
];

function input(toolName = "bash"): AutoClassifierInput {
	return {
		history,
		proposal: { toolName, input: { command: "git push fork HEAD" } },
	};
}

describe("auto approval classifier", () => {
	const registrations: Array<{ unregister(): void }> = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (registrations.length > 0) registrations.pop()?.unregister();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function setup() {
		const faux = registerFauxProvider();
		registrations.push(faux);
		return faux;
	}

	it("builds a reasoning-blind transcript with the current tool proposal", () => {
		const context = buildAutoClassifierContext(input(), "screen");
		const serialized = JSON.stringify(context.messages);
		const proposal = String(context.messages.at(-1)?.content);

		expect(context.messages.map(({ role }) => role)).toEqual(["user", "user"]);
		expect(serialized).toContain("Update the parser and push the branch.");
		expect(proposal).toContain('"toolName":"bash"');
		expect(serialized).not.toContain("PRIVATE ASSISTANT REASONING");
		expect(serialized).not.toContain("PRIVATE TOOL OUTPUT");
	});

	it("allows after the fast screen returns an unambiguous allow decision", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("ALLOW")]);

		const decision = await runAutoClassifier(
			{ model: faux.getModel(), auth: { apiKey: "faux-key" }, sessionId: "session-1" },
			input("read"),
		);

		expect(decision).toEqual(expect.objectContaining({ action: "allow", stage: "screen" }));
		expect(faux.getCallLog()).toHaveLength(1);
	});

	it("uses a reasoning pass when the fast screen requests review", async () => {
		const faux = setup();
		faux.setResponses([
			fauxAssistantMessage("REVIEW"),
			fauxAssistantMessage("The remote write is explicitly requested.\nDECISION: ALLOW"),
		]);

		const decision = await runAutoClassifier(
			{ model: faux.getModel(), auth: { apiKey: "faux-key" }, sessionId: "session-2" },
			input(),
		);

		expect(decision).toEqual(expect.objectContaining({ action: "allow", stage: "review" }));
		expect(faux.getCallLog()).toHaveLength(2);
	});

	it("escalates a blocked or malformed reasoning decision to user approval", async () => {
		const faux = setup();
		faux.setResponses([
			fauxAssistantMessage("REVIEW"),
			fauxAssistantMessage("The proposal exceeds the user's request.\nDECISION: BLOCK"),
			fauxAssistantMessage("MAYBE"),
			fauxAssistantMessage("No final protocol token."),
		]);

		const blocked = await runAutoClassifier(
			{ model: faux.getModel(), auth: { apiKey: "faux-key" }, sessionId: "session-3" },
			input(),
		);
		const malformed = await runAutoClassifier(
			{ model: faux.getModel(), auth: { apiKey: "faux-key" }, sessionId: "session-4" },
			input("edit"),
		);

		expect(blocked).toEqual(expect.objectContaining({ action: "ask", stage: "review" }));
		expect(malformed).toEqual(expect.objectContaining({ action: "ask", stage: "review" }));
		expect(faux.getCallLog()).toHaveLength(4);
	});

	it.each(["read", "edit", "bash"])("runs the screen for every %s proposal", async (toolName) => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("ALLOW")]);

		await runAutoClassifier(
			{ model: faux.getModel(), auth: { apiKey: "faux-key" }, sessionId: `session-${toolName}` },
			input(toolName),
		);

		expect(faux.getCallLog()).toHaveLength(1);
	});

	it("gates a real session tool call without exposing assistant reasoning", async () => {
		const harness = await createHarness({
			extensionFactories: [permissionSystemExtension],
		});
		harnesses.push(harness);
		await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		await harness.session.prompt("/approval-mode-cycle");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("PRIVATE MAIN-AGENT REASONING"), fauxToolCall("bash", { command: "printf auto-ok" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ALLOW"),
			fauxAssistantMessage("done"),
		]);

		expect(harness.getExtensionRunner().hasHandlers("tool_call")).toBe(true);
		await harness.session.prompt("Print auto-ok in the workspace.");

		const calls = harness.faux.getCallLog();
		const classifierCall = calls.find((call) => call.context.systemPrompt?.includes("fast first stage"));
		const classifierProposal = String(classifierCall?.context.messages.at(-1)?.content);
		expect(
			classifierCall,
			JSON.stringify({
				calls: calls.map((call) => ({ messages: call.context.messages, prompt: call.context.systemPrompt })),
				command: Boolean(harness.getExtensionRunner().getCommand("approval-mode-cycle")),
				events: harness.events,
			}),
		).toBeDefined();
		expect(classifierProposal).toContain('"toolName":"bash"');
		expect(JSON.stringify(classifierCall?.context.messages)).not.toContain("PRIVATE MAIN-AGENT REASONING");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
