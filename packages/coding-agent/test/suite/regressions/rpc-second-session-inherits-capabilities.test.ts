/**
 * A socket that registers its client capabilities on its first session keeps them for the next
 * session it opens: the router carries them over, so the second session's extension UI still
 * sends the `question` request the client said it can present instead of degrading it.
 */
import { expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

const ASK_QUESTION_COMMAND = `export default function (pi) {
	pi.registerCommand("ask-question", { description: "question fixture", handler: async (_args, ctx) => {
		await ctx.ui.question({ requestId: "second-session-question", waitForAnswer: true, timeoutMs: 60000,
			questions: [{ id: "q1", header: "q1", question: "q1", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] });
	} });
}`;

const DIALOG_METHODS = new Set(["question", "select", "input", "confirm"]);

it("gives a second session opened on the same socket the capabilities registered on the first", async () => {
	// Given: one socket that registered `question` through a session-level set_client_info on session A.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(ASK_QUESTION_COMMAND);
	try {
		const client = await host.connect();
		const first = await client.request({ type: "open_session", cwd: host.cwd });
		const sessionA = first.data?.sessionId;
		const info = await client.request({
			type: "set_client_info",
			sessionId: sessionA,
			width: 80,
			capabilities: ["question"],
		});

		// When: the same socket opens session B and an extension in B asks a question.
		const second = await client.request({ type: "open_session", cwd: host.cwd });
		const sessionB = second.data?.sessionId;
		const dialog = client.wait(
			(record) =>
				record.type === "extension_ui_request" &&
				record.sessionId === sessionB &&
				DIALOG_METHODS.has(String(record.method)),
		);
		const prompt = client.request({ type: "prompt", sessionId: sessionB, message: "/ask-question" });

		// Then: B sends the multi-question request itself, not the degraded single dialog.
		expect([first, info, second].map((response) => response.success)).toEqual([true, true, true]);
		expect(sessionB).not.toBe(sessionA);
		const request = await dialog;
		expect(request.method).toBe("question");
		client.send({
			type: "extension_ui_response",
			sessionId: sessionB,
			id: request.id,
			answers: { q1: { selected: ["A"] } },
		});
		expect((await prompt).success).toBe(true);
	} finally {
		await host.dispose();
	}
}, 120_000);
