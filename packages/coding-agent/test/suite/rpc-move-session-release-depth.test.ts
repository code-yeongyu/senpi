/**
 * senpi#6469 over a real host: the `move` release is what seals a session, after its extensions staged the state that
 * travels with it. State that a bundle could not carry (a path deeper than the cap) refuses the release before the
 * seal, so the session stays live on this host.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { MAX_BUNDLE_PATH_SEGMENTS, parseMoveId } from "../../src/core/session-move/bundle.ts";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import { afterReleased, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

/** An extension whose staged state has one file at a bundle path, `state/.../state.json`, of `segments` segments. */
const stagesStateAt =
	(segments: number): ExtensionFactory =>
	(pi) => {
		pi.on("session_move_export", async (event) => {
			const folder = join(event.dir, ...Array.from({ length: segments - 2 }, () => "d"));
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "state.json"), "{}\n");
		});
	};

describe("release_session for a move and the depth a bundle path may have (senpi#6469)", () => {
	it("#given an extension that stages state one folder deeper than a bundle path may be #when the session is released for a move #then the release is refused before the seal: no release entry, nothing staged is kept, and the session still runs a prompt", async () => {
		await using host = await startReleaseHost(stagesStateAt(MAX_BUNDLE_PATH_SEGMENTS + 1));
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("still here")]);
		const { sessionId, sessionPath, session } = await host.open("too-deep");

		const refused = await host.send({
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "move",
			moveId: "move-61",
			target: "laptop",
		});

		expect(refused).toMatchObject({ success: false, error: "release_failed" });
		expect(afterReleased(sessionPath)).toBeNull();
		const staged = outgoingStateDir(sessionPath, parseMoveId("move-61"));
		expect(existsSync(staged) ? readdirSync(staged) : []).toEqual([]);
		const settled = nextEvent(session, "agent_settled");
		expect(await host.send({ type: "prompt", id: "again", sessionId, message: "still writable?" })).toMatchObject({
			success: true,
		});
		await settled;
	});

	it("#given an extension that stages state exactly as deep as a bundle path may be #when the session is released for a move and exported #then both succeed", async () => {
		await using host = await startReleaseHost(stagesStateAt(MAX_BUNDLE_PATH_SEGMENTS));
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("just-fits");

		const released = await host.send({
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "move",
			moveId: "move-62",
			target: "laptop",
		});
		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-62",
			target: "laptop",
		});

		expect(released).toMatchObject({ success: true });
		expect(exported).toMatchObject({ success: true });
	});
});
