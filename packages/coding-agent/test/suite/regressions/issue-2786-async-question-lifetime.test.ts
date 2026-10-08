import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import {
	configureModeEnv,
	scratchRoot,
	seedFauxConfig,
	startWsAppServerMode,
	stopWsAppServerMode,
	threadIdFromResponse,
} from "../app-server-mode-harness.ts";
import { BufferedSocketReader, closeSocket, initializeSocket, openSocket } from "../app-server-mode-socket.ts";

describe("async questions across app-server turn completion (#2786)", () => {
	it("keeps the question replayable and delivers one answer after the asking turn ends", async () => {
		const root = await scratchRoot();
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"ask_user_question",
						{
							waitForAnswer: false,
							questions: [
								{
									header: "Choice",
									question: "Which target?",
									multiSelect: false,
									options: [{ label: "A" }, { label: "B" }],
								},
							],
						},
						{ id: "async-question" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("asking turn finished"),
			fauxAssistantMessage("late answer received"),
		]);
		await seedFauxConfig(root, faux);
		configureModeEnv(root);
		const running = await startWsAppServerMode(18994);
		const first = await openSocket(running.port);
		const reader = new BufferedSocketReader(first);
		let second: WebSocket | undefined;
		let replayReader: BufferedSocketReader | undefined;
		try {
			await initializeSocket(first, reader);
			first.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const threadId = threadIdFromResponse(await reader.readUntilResponse(2));
			// The socket reader is subscribed before the real agent turn starts.
			first.send(
				JSON.stringify({
					id: 3,
					method: "turn/start",
					params: { threadId, input: [{ type: "text", text: "Ask the scripted question." }] },
				}),
			);
			await reader.readUntilResponse(3);
			const request = await reader.readUntilNotification("item/tool/requestUserInput");
			expect(request).toMatchObject({ params: { threadId, waitForAnswer: false } });
			await reader.readUntilNotification("turn/completed");
			expect(faux.state.callCount).toBe(2);
			expect(getPendingQuestions(threadId)).toHaveLength(1);

			second = await openSocket(running.port);
			replayReader = new BufferedSocketReader(second);
			await initializeSocket(second, replayReader);
			second.send(JSON.stringify({ id: 4, method: "thread/resume", params: { threadId } }));
			await replayReader.readUntilResponse(4);
			const replay = await replayReader.readUntilNotification("item/tool/requestUserInput");
			expect(replay.id).toBe(request.id);
			const resolved = replayReader.readUntilNotification("serverRequest/resolved");
			second.send(JSON.stringify({ id: replay.id, result: { answers: { q1: { answers: ["B"] } } } }));
			await expect(resolved).resolves.toMatchObject({ params: { threadId, requestId: request.id } });
			await replayReader.readUntilNotification("turn/completed");
			expect(faux.state.callCount).toBe(3);
			expect(getPendingQuestions(threadId)).toHaveLength(0);
		} finally {
			reader.dispose();
			replayReader?.dispose();
			await closeSocket(first);
			if (second) await closeSocket(second);
			await stopWsAppServerMode(running);
			faux.unregister();
		}
	});
});
