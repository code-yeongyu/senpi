/**
 * The sealing attempt's extension state (senpi#3681 lead ruling). Once a `move` release wrote its seal, the folder the
 * seal names is the move's state: a release refused after the seal keeps it, and an export that cannot find it refuses
 * instead of bundling the session without its extension state.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { sealedOutgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";

const writesProbeState: ExtensionFactory = (pi) => {
	pi.on("session_move_export", async (event) => {
		mkdirSync(join(event.dir, "probe"), { recursive: true });
		writeFileSync(join(event.dir, "probe", "state.json"), '{"tasks":3}\n');
	});
};

const moveRelease = (sessionId: string, moveId: string) =>
	({ type: "release_session", id: `rel-${moveId}`, sessionId, reason: "move", moveId, target: "laptop" }) as const;

describe("the sealing attempt's extension state (senpi#3681 lead ruling)", () => {
	it("#given a move release whose teardown is refused after the seal #then the sealed attempt's folder is kept", async () => {
		await using host = await startReleaseHost(writesProbeState);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("sealed-refused");
		// Test-only: another close owning the entry is what makes the release's teardown answer false.
		Reflect.set(host.router, "tearDownReleased", async () => false);
		try {
			expect(await host.send(moveRelease(sessionId, "move-95"))).toMatchObject({
				success: false,
				error: "session_closing",
			});
		} finally {
			Reflect.deleteProperty(host.router, "tearDownReleased");
		}

		expect(readFileSync(sessionPath, "utf8")).toContain(SESSION_RELEASED_ENTRY_TYPE);
		const sealed = await sealedOutgoingStateDir(sessionPath, "move-95" as MoveId);
		expect(sealed).toBeDefined();
		expect(readFileSync(join(sealed ?? "", "probe", "state.json"), "utf8")).toBe('{"tasks":3}\n');
	});

	it("#given a session sealed for a move whose staged state folder is gone #when it is exported #then the export is refused, not bundled without the state", async () => {
		await using host = await startReleaseHost(writesProbeState);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("sealed-missing");
		expect(await host.send(moveRelease(sessionId, "move-96"))).toMatchObject({ success: true });
		const sealed = (await sealedOutgoingStateDir(sessionPath, "move-96" as MoveId)) ?? "";
		expect(existsSync(sealed)).toBe(true);
		rmSync(sealed, { recursive: true, force: true });

		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-96",
			target: "laptop",
		});

		expect(exported).toMatchObject({
			success: false,
			error: "move_failed",
			errorData: { detail: expect.stringContaining("extension state") },
		});
	});
});
