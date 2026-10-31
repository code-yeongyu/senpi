import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4272: open() normally converts attach failures to refusals; a rollback dependency can itself throw.
it("releases the accepted cut and route exactly once when physical open actually throws", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	host.client("peer");
	const checkpoints = host.writer.recoveryCheckpoints;
	const retired = vi.spyOn(checkpoints, "retireRoute");
	const unregistered = vi.spyOn(host.writer, "unregisterAdmission");
	const failure = new Error("rollback writer failed");
	vi.spyOn(host.writer, "attachConnectionToSession").mockImplementationOnce(() => {
		throw new Error("after acceptance");
	});
	vi.spyOn(host.writer, "forgetSession").mockImplementationOnce(() => {
		throw failure;
	});
	await expect(
		host.writer.withConnection("peer", () =>
			host.core.router.handle({
				type: "open_session",
				sessionPath: join(host.cwd, "throw.jsonl"),
				admissionId: "failed",
			}),
		),
	).rejects.toBe(failure);
	expect(retired).toHaveBeenCalledTimes(1);
	expect(retired).toHaveBeenCalledWith(
		{ socketEpoch: host.writer.socketEpochOf("peer"), sessionId: expect.any(String) },
		"failed",
	);
	expect(unregistered).toHaveBeenCalledExactlyOnceWith("peer", "failed");
	expect(checkpoints.status().open).toBe(0);
	expect(host.writer.ordinaryRoute("peer", retired.mock.calls[0]?.[0].sessionId ?? "")?.routes ?? []).toEqual([]);
	expect(host.core.router.sessionCount).toBe(0);
}, 120_000);

// #4272: exercise the real accepted producer's release twice, not two independent failed attempts.
it("makes a second accepted release a no-op for cuts routes and attachment ownership", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "release.jsonl");
	await peer.request({ type: "open_session", sessionPath, admissionId: "survivor" });
	let release: (() => Promise<void>) | undefined;
	const run = CompactAdmissions.prototype.run;
	vi.spyOn(CompactAdmissions.prototype, "run").mockImplementation(function (
		this: CompactAdmissions,
		identity,
		produce,
	) {
		return run.call(this, identity, async (signal) => {
			const produced = await produce(signal);
			release = produced.release;
			return produced;
		});
	});
	const opened = await peer.request({
		type: "open_session",
		sessionPath,
		admissionId: "accepted",
	});
	const retired = vi.spyOn(host.writer.recoveryCheckpoints, "retireRoute");
	const unregistered = vi.spyOn(host.writer, "unregisterAdmission");
	const releaseAccepted = release ?? expect.unreachable("no accepted producer");
	await releaseAccepted();
	expect(host.writer.recoveryCheckpoints.status().open).toBe(1);
	expect(host.writer.ordinaryRoute("peer", String(opened.sessionId))?.routes).toEqual(["survivor"]);
	expect(host.core.router.sessionCount).toBe(1);
	await releaseAccepted();
	expect(retired).toHaveBeenCalledTimes(1);
	expect(unregistered).toHaveBeenCalledExactlyOnceWith("peer", "accepted");
	expect(dataOf(await peer.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ sessionId: opened.sessionId, attachments: 1 }),
	]);
}, 120_000);

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
