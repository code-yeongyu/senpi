import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { reservationStep } from "../suite/rpc-worker-reservation-support.ts";
import { OWNED_TURN_ENTRY, startHostRig } from "./headless-host-support.ts";

describe("headless engine owns its sessions", () => {
	it("keeps a session and its running turn after the creating client detaches, and another client sees the result", async () => {
		const rig = await startHostRig("headless");
		try {
			rig.connect("a");
			rig.connect("b");
			const file = await rig.newSessionFile();
			const sessionId = await rig.openSession("a", file);
			const turn = rig.send("a", { type: "prompt", id: "turn", sessionId, message: "/owned-turn" });
			await reservationStep("headless-turn-started", rig.turnStarted);

			await rig.detach("a");
			expect(await rig.listSessions("b")).toMatchObject([
				{ sessionId, status: "open", attachments: 0, retain_on_disconnect: true },
			]);

			rig.releaseTurn();
			await reservationStep("headless-turn-finished", turn);
			expect(SessionManager.open(file).getEntries()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: OWNED_TURN_ENTRY }),
			);
			expect(await rig.openSession("b", file)).toBe(sessionId);
			expect(await rig.listSessions("b")).toMatchObject([{ sessionId, status: "open", attachments: 1 }]);
		} finally {
			await rig.dispose();
		}
	}, 30_000);

	it("honors a client that opens a session with retain_on_disconnect: false", async () => {
		const rig = await startHostRig("headless");
		try {
			rig.connect("a");
			rig.connect("b");
			await rig.send("a", {
				type: "open_session",
				id: "explicit",
				cwd: rig.root,
				sessionPath: await rig.newSessionFile(),
				retain_on_disconnect: false,
			});
			expect((await rig.response("explicit")).success).toBe(true);
			await rig.detach("a");
			expect((await rig.listSessions("b")).filter((row) => row.status === "open")).toEqual([]);
		} finally {
			await rig.dispose();
		}
	}, 30_000);

	it("does not exit when it has no sessions, where a client-owned host does", async () => {
		let now = 0;
		const exits = { headless: vi.fn(), "client-owned": vi.fn() };
		for (const kind of ["headless", "client-owned"] as const) {
			const rig = await startHostRig(kind, { now: () => now, emptyExitMs: 1_000, onEmptyExit: exits[kind] });
			try {
				rig.core.router.sweepIdleSessions();
				now += 2_000;
				rig.core.router.sweepIdleSessions();
			} finally {
				await rig.dispose();
			}
		}
		expect(exits.headless).not.toHaveBeenCalled();
		expect(exits["client-owned"]).toHaveBeenCalledOnce();
	});

	it("a client-owned host still ends a session when its last client leaves", async () => {
		const rig = await startHostRig("client-owned");
		try {
			rig.connect("a");
			rig.connect("b");
			await rig.openSession("a", await rig.newSessionFile());
			await rig.detach("a");
			expect((await rig.listSessions("b")).filter((row) => row.status === "open")).toEqual([]);
		} finally {
			await rig.dispose();
		}
	}, 30_000);
});
