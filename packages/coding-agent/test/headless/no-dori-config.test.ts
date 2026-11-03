import { readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { reservationPhase } from "../suite/rpc-worker-reservation-support.ts";
import { OWNED_TURN_ENTRY, startHostRig } from "./headless-host-support.ts";

it("serves a session and completes its turn from an agent dir holding no configuration at all", async () => {
	const rig = await startHostRig("headless");
	try {
		const file = await rig.newSessionFile();
		expect(await readdir(rig.root)).toEqual([file.slice(rig.root.length + 1)]);
		rig.connect("a");
		const sessionId = await rig.openSession("a", file);
		const turn = rig.send("a", { type: "prompt", id: "turn", sessionId, message: "/owned-turn" });
		await reservationPhase("no-config-turn-started", rig.turnStarted);
		rig.releaseTurn();
		await reservationPhase("no-config-turn-finished", turn);
		expect((await rig.response("turn")).success).toBe(true);
		expect(SessionManager.open(file).getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: OWNED_TURN_ENTRY }),
		);
	} finally {
		await rig.dispose();
	}
}, 30_000);
