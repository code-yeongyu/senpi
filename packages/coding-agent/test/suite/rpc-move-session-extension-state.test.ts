/**
 * `move_session export` bundles the extension state the `move` release staged (senpi#3681): the RPC export reads
 * the release's staging folder, so what `session_move_export` handlers wrote travels as the `extension-state` payload.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { readManifest } from "../../src/core/session-move/bundle.ts";
import { EXTENSION_STATE_PAYLOAD, outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveStatus } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";

const writesProbeState: ExtensionFactory = (pi) => {
	pi.on("session_move_export", async (event) => {
		mkdirSync(join(event.dir, "probe"), { recursive: true });
		writeFileSync(join(event.dir, "probe", "state.json"), '{"tasks":3}\n');
	});
};

describe("move_session export with extension state (senpi#3681)", () => {
	it("#given a move release whose extension staged state #when the session is exported over RPC #then the bundle carries it", async () => {
		await using host = await startReleaseHost(writesProbeState);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("rpc-state");
		await host.send({
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "move",
			moveId: "move-51",
			target: "laptop",
		});

		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-51",
			target: "laptop",
		});

		expect(exported).toMatchObject({ success: true });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;
		expect((await readManifest(bundleDir)).payloads).toEqual([
			{
				kind: EXTENSION_STATE_PAYLOAD,
				files: [{ path: join("state", "probe", "state.json"), sha256: expect.any(String) }],
			},
		]);
	});

	const answers: readonly MoveStatus[] = [{ state: "accepted" }, { state: "declined", reason: "cancelled" }];
	for (const answer of answers) {
		it(`#given an exported move #when finish settles it as ${answer.state} #then the staged extension state is removed`, async () => {
			await using host = await startReleaseHost(writesProbeState);
			host.faux.setResponses([fauxAssistantMessage("seed reply")]);
			const { sessionId, sessionPath } = await host.open(`rpc-state-${answer.state}`);
			await host.send({
				type: "release_session",
				id: "rel",
				sessionId,
				reason: "move",
				moveId: "move-52",
				target: "laptop",
			});
			await host.send({
				type: "move_session",
				id: "exp",
				op: "export",
				sessionPath,
				moveId: "move-52",
				target: "laptop",
			});
			const staged = outgoingStateDir(sessionPath, "move-52" as MoveId);
			expect(existsSync(staged)).toBe(true);

			const finished = await host.send({
				type: "move_session",
				id: "fin",
				op: "finish",
				sessionPath,
				moveId: "move-52",
				answer,
			});

			expect(finished).toMatchObject({ success: true });
			expect(existsSync(staged)).toBe(false);
		});
	}
});
