import { describe, expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795, senpi#6245: admission is enforced by default at the real socket boundary in both runtimes.
describe.each(["in-process", "worker"] as const)("attachment gate (%s)", (sessionRuntime) => {
	it("refuses unattached mutations while keeping observational reads and existing close refusals", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const owner = await host.connect();
			const stranger = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			expect(opened.success).toBe(true);
			const sessionId = opened.data?.sessionId;
			const mutations = [
				{ type: "append_user_message", content: "not admitted" },
				{ type: "prompt", message: "not admitted" },
				{ type: "steer", message: "not admitted" },
				{ type: "abort" },
				{ type: "wake" },
				{ type: "release_session", reason: "takeover" },
				{ type: "extension_ui_response", confirmed: true },
				{ type: "export_jsonl", outputPath: `${host.scratch}/export.jsonl` },
				{ type: "export_html", outputPath: `${host.scratch}/export.html` },
				{ type: "unload_session" },
				{ type: "set_client_info", capabilities: [] },
				{ type: "record_user_activity", kind: "draft" },
				{ type: "account_reset", provider: "openai", name: "work" },
				{ type: "future_session_mutation" },
			];
			for (const mutation of mutations) {
				expect(await stranger.request({ ...mutation, sessionId }), mutation.type).toMatchObject({
					success: false,
					errorCode: "session_not_attached",
					errorData: {
						reason: expect.any(String),
						action:
							"attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
					},
				});
			}
			for (const type of ["get_state", "get_messages"]) {
				expect(await stranger.request({ type, sessionId }), type).toMatchObject({ success: true });
			}
			expect(await stranger.request({ type: "list_sessions" })).toMatchObject({ success: true });
			expect(await stranger.request({ type: "close_session", sessionId })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
			expect(await stranger.request({ type: "set_session_context", sessionId, patch: {} })).toMatchObject({
				success: false,
				errorCode: "session_not_attached",
			});
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
