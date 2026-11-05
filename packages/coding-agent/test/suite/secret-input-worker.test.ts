import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const extension = `export default function(pi) {
	pi.registerCommand("private-input", {description: "synthetic secret fixture", handler: async (_args, ctx) => {
		try {
			const value = await ctx.ui.input("Private credential", undefined, {secret: true});
			ctx.ui.notify(value === undefined ? "private:cancelled" : "private:consumed");
		} catch (error) {
			ctx.ui.notify(error?.code === "secret_input_unavailable" ? "private:" + error.reason : "private:unexpected");
		}
	}});
}`;

// senpi#5108: an isolate must receive typed refusal before emission, not a grant-style cancellation.
it.each(["worker", "in-process"] as const)(
	"gates the actual owner before emission on %s",
	async (sessionRuntime) => {
		const host = await startWorkerHost(extension, { socket: true, sessionRuntime });
		try {
			const a = await host.connect();
			const b = await host.connect();
			const opened = await a.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			expect(opened.success).toBe(true);
			expect(
				(await b.request({ type: "attach_session", sessionId, durableSessionId: opened.data?.state?.sessionId }))
					.success,
			).toBe(true);
			for (const order of [
				[a, b],
				[b, a],
			]) {
				for (const client of order)
					expect(
						(
							await client.request({
								type: "set_client_info",
								sessionId,
								width: 80,
								capabilities: ["interactive_user", ...(client === a ? ["secret_input_v1"] : [])],
							})
						).success,
					).toBe(true);
				const outcome = b.wait(
					(r) =>
						r.type === "extension_ui_request" &&
						(r.method === "input" || r.message === "private:client_unsupported"),
					15_000,
				);
				const prompt = b.request({ type: "prompt", sessionId, message: "/private-input" }).then((reply) => {
					expect(reply.success, JSON.stringify(reply)).toBe(true);
					return reply;
				});
				expect(await outcome).toMatchObject({ method: "notify", message: "private:client_unsupported" });
				await prompt;
				expect(b.records.some((r) => r.method === "input")).toBe(false);
				const presented = a.wait((r) => r.type === "extension_ui_request" && r.method === "input", 15_000);
				const acceptedPrompt = a.request({ type: "prompt", sessionId, message: "/private-input" });
				const request = await presented;
				expect(request.secret).toBe(true);
				const refused = b.wait((r) => r.type === "response" && r.id === "foreign", 15_000);
				b.send({
					type: "extension_ui_response",
					sessionId,
					id: "foreign",
					uiRequestId: request.id,
					answerId: "foreign",
					secret: true,
					value: "synthetic",
				});
				expect(await refused).toMatchObject({ success: false, error: "secret_answer_refused" });
				const consumed = a.wait((r) => r.message === "private:consumed", 15_000);
				a.send({
					type: "extension_ui_response",
					sessionId,
					id: "owner",
					uiRequestId: request.id,
					answerId: crypto.randomUUID(),
					secret: true,
					value: "synthetic",
				});
				await consumed;
				await acceptedPrompt;
			}
		} finally {
			await host.dispose();
		}
	},
	120_000,
);
