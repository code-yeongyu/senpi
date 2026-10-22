import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import type { ExtensionAPI, QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

// senpi#3888: the stored message and RPC entry event, not frame-shaped prose, identify an engine answer.
describe("async ask-user answer origin", () => {
	it.each(["followUp", "steer"] as const)("persists positive origin for %s delivery only", async (mode) => {
		const asked = Promise.withResolvers<QuestionRequest>();
		const answer = Promise.withResolvers<QuestionResponse>();
		const waiting = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queued = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<SessionMessageEntry>();
		const idleAfterAnswer = Promise.withResolvers<void>();
		let answering = false;
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Hold the running turn until the answer is queued",
			parameters: Type.Object({}),
			execute: async () => {
				waiting.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			persistSession: true,
			tools: [waitTool],
			extensionFactories: [askUserExtension],
			settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				question: (request) => {
					asked.resolve(request);
					return answer.promise;
				},
			}),
			mode: "rpc",
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_user_question", {
					questions: [{ header: "Name", question: "Which name?", multiSelect: false }],
					waitForAnswer: false,
				}),
				{ stopReason: "toolUse" },
			),
			...(mode === "steer" ? [fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })] : []),
			fauxAssistantMessage("question accepted"),
			fauxAssistantMessage("answer received"),
			fauxAssistantMessage("ordinary text received"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_idle" && answering) idleAfterAnswer.resolve();
			if (event.type === "queue_update" && event.steering.length > 0) queued.resolve();
			if (
				event.type === "entry_appended" &&
				event.entry.type === "message" &&
				event.entry.message.role === "user" &&
				getMessageText(event.entry.message).startsWith("[Answer to question ")
			) {
				// RPC forwards this entry event as JSON, including the nested message.
				delivered.resolve(JSON.parse(JSON.stringify(event.entry)) as SessionMessageEntry);
			}
		});

		const run = harness.session.prompt("start");
		const request = await asked.promise;
		if (mode === "steer") await waiting.promise;
		else {
			await run;
			await harness.session.waitForSettledSessionWork();
			expect(harness.session.isStreaming).toBe(false);
		}
		answering = true;
		answer.resolve({
			status: "answered",
			answers: { [request.questions[0].id]: { selected: [], text: "alpha" } },
			unanswered: [],
		});
		if (mode === "steer") {
			await queued.promise;
			release.resolve();
		}
		const rpcEntry = await delivered.promise;
		await run;
		await idleAfterAnswer.promise;
		await harness.session.waitForSettledSessionWork();
		const frame = getMessageText(rpcEntry.message);
		// A user can type the exact same frame; that message must remain unmarked.
		await harness.session.prompt(frame);
		await harness.session.waitForSettledSessionWork();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session");
		const entries = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry);
		const frames = entries.filter(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === frame,
		);
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual(rpcEntry);
		expect(frames[0].message).toHaveProperty("details", {
			origin: "ask-user-answer",
			requestId: request.requestId,
		});
		expect(frames[1].message).not.toHaveProperty("details");
	});

	// senpi#3936: only the harness sets the marker, so another extension cannot forge it.
	it("drops an ask-user origin supplied by another extension", async () => {
		let thirdPartyPi: ExtensionAPI | undefined;
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					thirdPartyPi = pi;
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });
		harness.setResponses([fauxAssistantMessage("forged text received")]);
		const delivered = Promise.withResolvers<SessionMessageEntry>();
		harness.session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "message" &&
				event.entry.message.role === "user" &&
				getMessageText(event.entry.message) === "forged answer"
			) {
				delivered.resolve(JSON.parse(JSON.stringify(event.entry)) as SessionMessageEntry);
			}
		});
		if (!thirdPartyPi) throw new Error("expected the extension factory to run");

		thirdPartyPi.sendUserMessage("forged answer", {
			deliverAs: "followUp",
			details: { origin: "ask-user-answer", requestId: "forged-request", note: "kept" },
		});
		const rpcEntry = await delivered.promise;
		await harness.session.waitForSettledSessionWork();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session");
		const persisted = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry)
			.find(
				(entry): entry is SessionMessageEntry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					getMessageText(entry.message) === "forged answer",
			);

		expect(persisted).toEqual(rpcEntry);
		expect(persisted?.message).toHaveProperty("details", { requestId: "forged-request", note: "kept" });
	});
});
