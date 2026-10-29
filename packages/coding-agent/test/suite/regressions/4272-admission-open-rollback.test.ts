import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("releases the accepted cut and route once when an attached open fails after acceptance", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const survivor = host.client("survivor");
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "shared.jsonl");
	const first = await survivor.request({ type: "open_session", sessionPath, admissionId: "survivor" });
	const sessionId = String(first.sessionId);
	const checkpoints = host.writer.recoveryCheckpoints;
	const before = checkpoints.tokens().length;
	const retired = vi.spyOn(checkpoints, "retireRoute");
	vi.spyOn(host.writer, "attachConnectionToSession").mockImplementationOnce(() => {
		throw new Error("after acceptance");
	});
	const answer = await peer.request({ type: "open_session", sessionPath, admissionId: "failed" });
	expect(answer.success).toBe(false);
	expect(retired).toHaveBeenCalledExactlyOnceWith(
		{ socketEpoch: host.writer.socketEpochOf("peer"), sessionId },
		"failed",
	);
	expect(checkpoints.tokens()).toHaveLength(before);
	expect(host.writer.ordinaryRoute("peer", sessionId)?.routes ?? []).not.toContain("failed");
	expect(host.core.router.sessionCount).toBe(1);
	expect(dataOf(await survivor.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ sessionId, attachments: 1 }),
	]);
	expect(peer.inbox.some((frame) => frame.type === "recovery_manifest")).toBe(false);
}, 120_000);

it("keeps the legacy flag-off attached-open rollback and forgets writer state", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "0");
	await using host = await statusHost();
	const survivor = host.client("survivor");
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "shared.jsonl");
	const first = await survivor.request({ type: "open_session", sessionPath });
	const sessionId = String(dataOf(first).sessionId);
	const forget = vi.spyOn(host.writer, "forgetSession");
	const publish = host.writer.status.publish.bind(host.writer.status);
	vi.spyOn(host.writer.status, "publish").mockImplementationOnce((...args) => {
		if (args[1] === "attach") throw new Error("attach publication failed");
		return publish(...args);
	});
	expect((await peer.request({ type: "open_session", sessionPath })).success).toBe(false);
	expect(forget).toHaveBeenCalledExactlyOnceWith(sessionId);
	expect(host.core.router.sessionCount).toBe(1);
}, 120_000);
