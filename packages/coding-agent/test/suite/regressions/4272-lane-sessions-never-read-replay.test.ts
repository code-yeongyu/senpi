import { afterEach, expect, it, vi } from "vitest";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { FLAG, HOSTS, laneOwned, type Opened, storeCalls } from "./4272-construction-host-support.ts";

// Part of #4272 (S07b, RULING-52 condition 3): a lane-owned session never reads the replay store. Every store method
// is instrumented; across the opener's admission, a late attach, a shed and its recovery, and the status stream,
// none is called for the session (the close's `forget` is cleanup, not a read).

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const attach = (opened: Opened) => ({
	type: "attach_session",
	sessionId: opened.sessionId,
	durableSessionId: opened.durableSessionId,
});

it.each(HOSTS)(
	"%s: no replay-store read for a lane-owned session across admission, attach, shed recovery and status",
	async (_kind, create) => {
		vi.stubEnv(FLAG, "1");
		const calls = storeCalls();
		const host = await create();
		try {
			const watcher = host.connect("w");
			expect((await host.request("w", { type: "subscribe_sessions" })).success).toBe(true);
			host.connect("a");
			const opened = await host.open("a");
			const peer = host.connect("r", { maxQueueBytes: 256, capabilities: [EVENT_RESYNC_CAPABILITY] });
			expect((await host.request("r", attach(opened))).success).toBe(true);
			await host.writer.flush();
			peer.hold();
			await host.turn(opened.sessionId, "a", false);
			peer.release();
			await host.writer.flush();
			host.connect("b");
			expect((await host.request("b", attach(opened))).success).toBe(true);
			await host.writer.flush();

			expect(host.driven).toEqual([{ sessionId: opened.sessionId, laneOwned: true }]);
			expect(laneOwned(host.writer, opened.sessionId)).toBe(true);
			expect(
				peer.lines.some((line) => line.type === "resync_required" && line.sessionId === opened.sessionId),
				"the shed's recovery read a cut for the session",
			).toBe(true);
			expect(
				watcher.lines.some(
					(line) => line.type === "session_status" && JSON.stringify(line).includes(opened.sessionId),
				),
				"the status stream derived the session's status",
			).toBe(true);
			expect(calls.filter(({ method, sessionId }) => sessionId === opened.sessionId && method !== "forget")).toEqual(
				[],
			);
		} finally {
			await host.dispose();
		}
	},
	120_000,
);
