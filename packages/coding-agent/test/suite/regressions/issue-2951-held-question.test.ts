import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { startInProcessHost } from "../rpc-worker-host-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const extension = `export default function (pi) {
	pi.registerCommand("held-question", { handler: async (_args, ctx) => {
		pi.appendEntry("held-question-started", {});
		const result = await ctx.ui.question({ requestId: "held-question", waitForAnswer: true, timeoutMs: 60000,
			questions: [{ id: "q", header: "q", question: "Continue?", options: [{ label: "yes" }, { label: "no" }], multiSelect: false }] });
		pi.appendEntry("held-question-finished", { status: result.status });
		ctx.ui.notify("held-question-finished");
	} });
}`;

// senpi#2951: UI replies finish an admitted turn; they do not admit a new writer.
it.each(["response", "progress"] as const)(
	"delivers held admitted-question %s and persists the admitted turn completion",
	async (kind) => {
		vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
		const host = await startInProcessHost(extension);
		let prompt: ReturnType<typeof host.request> | undefined;
		try {
			const client = await host.connect();
			const file = join(host.scratch, "question.jsonl");
			const durableId = randomUUID();
			await writeFile(
				file,
				`${JSON.stringify({ type: "session", version: 3, id: durableId, cwd: host.cwd, timestamp: new Date(0).toISOString() })}\n`,
			);
			const opened = await client.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath: file,
				capabilities: ["question"],
			});
			const sessionId = opened.data?.sessionId;
			expect(opened.success).toBe(true);
			await client.request({ type: "set_client_info", sessionId, width: 80, capabilities: ["question"] });
			const asked = client.wait((record) => record.type === "extension_ui_request" && record.method === "question");
			prompt = client.request({ type: "prompt", sessionId, message: "/held-question" });
			const question = await asked;
			if (!question.id) throw new Error("Question was not published");
			await using holder = await startSessionHolder(file, durableId, host.cwd);
			if (kind === "progress") {
				const progressed = client.wait(
					(record) =>
						record.id === question.id &&
						(record.type === "question_updated" ||
							(record.type === "response" && record.command === "extension_ui_progress")),
				);
				client.send({
					type: "extension_ui_progress",
					sessionId,
					id: question.id,
					answers: { q: { selected: ["yes"] } },
				});
				expect(await progressed).toMatchObject({ type: "question_updated", id: question.id });
			}
			const replied = client.wait((record) => record.type === "response" && record.id === "held-answer");
			const finished = client.wait(
				(record) =>
					(record.type === "extension_ui_request" &&
						record.method === "notify" &&
						record.message === "held-question-finished") ||
					(record.type === "response" && record.id === "held-answer" && record.success === false),
			);
			client.send({
				type: "extension_ui_response",
				sessionId,
				id: "held-answer",
				uiRequestId: question.id,
				answers: { q: { selected: ["yes"] } },
			});
			expect(await replied).toMatchObject({ success: true });
			await finished;
			expect((await prompt).success).toBe(true);
			expect(
				SessionManager.open(file)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "held-question-finished"),
			).toMatchObject([{ data: { status: "answered" } }]);
			expect(process.kill(holder.pid, 0)).toBe(true);
			expect(await client.request({ type: "set_session_name", sessionId, name: "blocked" })).toMatchObject({
				success: false,
				error: "session_held",
			});
		} finally {
			try {
				await Promise.all([Promise.allSettled(prompt ? [prompt] : []), host.dispose()]);
			} finally {
				vi.unstubAllEnvs();
			}
		}
	},
	120_000,
);
