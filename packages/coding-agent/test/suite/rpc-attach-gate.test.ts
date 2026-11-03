import { describe, expect, it } from "vitest";
import { waitForStderr } from "../helpers/rpc-socket-host-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795: admission is enforced at the real socket boundary in both runtimes.
describe.each(["in-process", "worker"] as const)("attachment gate (%s)", (sessionRuntime) => {
	it("refuses unattached mutations while keeping observational reads and existing close refusals", async () => {
		const host = await startWorkerHost(undefined, {
			socket: true,
			sessionRuntime,
			preload: 'process.env.SENPI_RPC_REQUIRE_ATTACH = "1";',
		});
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
			expect(host.stderrText()).not.toContain("(refused from the next release)");
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("serves each unattached mutation in grace and logs exactly once per violation", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const owner = await host.connect();
			const stranger = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			expect(opened.success).toBe(true);
			for (const type of ["append_user_message", "abort"]) {
				const logged = waitForStderr(
					host.child,
					`senpi rpc host: ${type} on ${sessionId} from a connection not attached to it (refused from the next release)`,
				);
				expect(await stranger.request({ type, sessionId, content: "grace" })).toMatchObject({ success: true });
				await logged;
			}
			await stranger.request({ type: "get_state", sessionId });
			const violations = host
				.stderrText()
				.split("\n")
				.filter((line) => line.includes("(refused from the next release)"));
			expect(violations).toEqual([
				`senpi rpc host: append_user_message on ${sessionId} from a connection not attached to it (refused from the next release)`,
				`senpi rpc host: abort on ${sessionId} from a connection not attached to it (refused from the next release)`,
			]);
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
