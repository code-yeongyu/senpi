import { describe, expect, it } from "vitest";
import { waitForStderr } from "../helpers/rpc-socket-host-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const REFUSED = {
	success: false,
	errorCode: "session_not_attached",
	errorData: {
		reason: expect.any(String),
		action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
	},
};

const enforcing = { preload: 'process.env.SENPI_RPC_REQUIRE_ATTACH = "1";' };

// senpi#3795: resume_session releases engine holds, so it is a mutation that requires attachment. Per
// design v7.1 an open_session { attended: false } hold is an attachment like any other open.
describe.each(["in-process", "worker"] as const)("attachment gate and unattended holds (%s)", (sessionRuntime) => {
	it("refuses resume_session from an unattached connection and serves it to the attached one", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime, ...enforcing });
		try {
			const owner = await host.connect();
			const stranger = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			expect(opened.success).toBe(true);
			const sessionId = opened.data?.sessionId;
			expect(await stranger.request({ type: "resume_session", sessionId })).toMatchObject(REFUSED);
			expect(await owner.request({ type: "resume_session", sessionId })).toMatchObject({
				command: "resume_session",
				success: true,
			});
			expect(host.stderrText()).not.toContain("(refused from the next release)");
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("serves an unattached resume_session in grace and logs it once", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const owner = await host.connect();
			const stranger = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			const line = `senpi rpc host: resume_session on ${sessionId} from a connection not attached to it (refused from the next release)`;
			const logged = waitForStderr(host.child, line);
			expect(await stranger.request({ type: "resume_session", sessionId })).toMatchObject({
				command: "resume_session",
				success: true,
			});
			await logged;
			expect(
				host
					.stderrText()
					.split("\n")
					.filter((entry) => entry.includes("(refused from the next release)")),
			).toEqual([line]);
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("counts an unattended open as an attachment of its connection (design v7.1)", async () => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime, ...enforcing });
		try {
			const owner = await host.connect();
			const observer = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd });
			const sessionId = opened.data?.sessionId;
			const sessionPath = opened.data?.state?.sessionFile;
			expect(
				await observer.request({ type: "open_session", cwd: host.cwd, sessionPath, attended: false }),
			).toMatchObject({ success: true, data: { sessionId, attached: true } });
			expect((await observer.request({ type: "list_sessions" })).data?.sessions).toEqual([
				expect.objectContaining({ sessionId, attachments: 2 }),
			]);
			expect(await observer.request({ type: "append_user_message", sessionId, content: "attached" })).toMatchObject({
				success: true,
			});
			expect(await observer.request({ type: "resume_session", sessionId })).toMatchObject({ success: true });
			expect(await observer.request({ type: "close_session", sessionId })).toMatchObject({ success: true });
			expect((await observer.request({ type: "list_sessions" })).data?.sessions).toEqual([
				expect.objectContaining({ sessionId, attachments: 1 }),
			]);
			expect(await observer.request({ type: "resume_session", sessionId })).toMatchObject(REFUSED);
			expect(host.stderrText()).not.toContain("(refused from the next release)");
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
