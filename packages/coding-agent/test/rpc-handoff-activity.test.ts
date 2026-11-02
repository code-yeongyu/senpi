import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isSessionBusySnapshot, type SessionActivitySnapshot } from "../src/core/session-activity.ts";
import { isHandoffBusy } from "../src/modes/rpc/handoff-activity.ts";
import { DEFAULT_HANDOFF_GRACE_MS } from "../src/modes/rpc/host-lifecycle.ts";
import { opened } from "./suite/rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./suite/rpc-inprocess-host-support.ts";

const idle: SessionActivitySnapshot = {
	isStreaming: false,
	isBashRunning: false,
	isCompacting: false,
	hasSessionWork: false,
	hasActiveWakeSource: false,
};

it("excludes only durable wake sources from handoff activity, not ordinary idle eviction", () => {
	expect(DEFAULT_HANDOFF_GRACE_MS).toBe(600_000);
	expect(isHandoffBusy(idle)).toBe(false);
	const monitor = { ...idle, hasActiveWakeSource: true };
	expect(isSessionBusySnapshot(monitor)).toBe(true);
	expect(isHandoffBusy(monitor)).toBe(false);
	for (const key of ["isStreaming", "isBashRunning", "isCompacting", "hasSessionWork"] as const) {
		expect(isHandoffBusy({ ...monitor, [key]: true })).toBe(true);
	}
});

it("does not park while an accepted host request is still in flight", async () => {
	const dir = await mkdtemp(join(tmpdir(), "handoff-request-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const parked = Promise.withResolvers<void>();
	try {
		await using rig = createInProcessRig(dir, { onHandoffParked: async () => parked.resolve() }, async () => {
			entered.resolve();
			await release.promise;
		});
		const session = opened(await rig.open("client", { cwd: dir, sessionPath: join(dir, "request.jsonl") }), 0);
		const request = rig.router.handle({ type: "get_state", sessionId: session.sessionId });
		await entered.promise;
		rig.router.beginDrain();
		expect(rig.registry.peek(session.sessionId)?.state).toBe("open");
		expect(rig.records().some((record) => record.type === "session_closed")).toBe(false);
		release.resolve();
		await request;
		await parked.promise;
		expect(rig.registry.peek(session.sessionId)).toBeUndefined();
	} finally {
		release.resolve();
		await rm(dir, { recursive: true, force: true });
	}
}, 10_000);
