/**
 * Over a real host the `move` release is what seals a session, after its extensions staged the state that travels with
 * it; the export that follows only takes a session already sealed. So a staged file whose name a bundle cannot list
 * (see `session-move-export-plain-names.test.ts`) refuses the release, before the seal: the session stays live on
 * this host, and the refusal names the file.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { parseMoveId } from "../../src/core/session-move/bundle.ts";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import { afterReleased, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

/** An extension whose staged state has one file of this name, listed in a bundle as `state/probe/<name>`. */
const stagesFileNamed =
	(name: string): ExtensionFactory =>
	(pi) => {
		pi.on("session_move_export", async (event) => {
			mkdirSync(join(event.dir, "probe"), { recursive: true });
			writeFileSync(join(event.dir, "probe", name), "{}\n");
		});
	};

// A backslash is an ordinary character of a name only off Windows.
describe.skipIf(process.platform === "win32")("release_session for a move and a name a bundle cannot list", () => {
	it.each(["a\\.\\b.json", "a\\..\\b.json"])(
		"#given an extension that stages a file named %s #when the session is released for a move #then the release is refused before the seal, naming the file: no release entry, nothing staged is left, and the session still takes a prompt",
		async (name) => {
			await using host = await startReleaseHost(stagesFileNamed(name));
			host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("still here")]);
			const { sessionId, sessionPath, session } = await host.open("odd-name");

			const refused = await host.send({
				type: "release_session",
				id: "rel",
				sessionId,
				reason: "move",
				moveId: "move-63",
				target: "laptop",
			});

			expect(refused).toMatchObject({
				success: false,
				error: "release_failed",
				errorData: { detail: expect.stringContaining(JSON.stringify(`state/probe/${name}`)) },
			});
			expect(afterReleased(sessionPath)).toBeNull();
			const staged = outgoingStateDir(sessionPath, parseMoveId("move-63"));
			expect(existsSync(staged) ? readdirSync(staged) : []).toEqual([]);
			const settled = nextEvent(session, "agent_settled");
			expect(await host.send({ type: "prompt", id: "again", sessionId, message: "still writable?" })).toMatchObject({
				success: true,
			});
			await settled;
		},
	);
});
