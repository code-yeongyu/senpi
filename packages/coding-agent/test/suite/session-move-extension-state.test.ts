/**
 * Extension state that follows a moved session (senpi#3676, design v7 section 4). An extension writes what it keeps
 * outside the session folder into the move while its runtime is still live (`session_move_export`, at the `move`
 * release), the bundle carries it, and the receiver hands it back once when the session is next opened
 * (`session_move_import`). A failing export handler refuses the release, so nothing is sealed without its state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { MOVED_STATE_RESTORED, movedStateDir, pendingMovedState } from "../../src/core/session-move/extension-state.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { customTypes, type MOVE, setup, writeSession } from "./session-move-fixture.ts";

function probeExtension(options: { readonly failExport?: boolean } = {}) {
	const seen: { exportDir?: string; importDir?: string; imported?: string } = {};
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_move_export", async (event) => {
			seen.exportDir = event.dir;
			if (options.failExport === true) throw new Error("probe state is locked");
			mkdirSync(join(event.dir, "probe"), { recursive: true });
			writeFileSync(join(event.dir, "probe", "state.json"), '{"tasks":3}\n');
		});
		pi.on("session_move_import", async (event) => {
			seen.importDir = event.dir;
			seen.imported = readFileSync(join(event.dir, "probe", "state.json"), "utf8");
		});
	};
	return { extension, seen };
}

describe("extension state on a move release (senpi#3676)", () => {
	it("#given an extension with export state #when the session is released for a move #then its state is written while it is still live", async () => {
		const probe = probeExtension();
		await using host = await startReleaseHost(probe.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId } = await host.open("with-state");

		const reply = await host.send({
			type: "release_session",
			id: "rel-move",
			sessionId,
			reason: "move",
			moveId: "move-41",
			target: "laptop",
		});

		expect(reply).toMatchObject({ success: true });
		expect(probe.seen.exportDir).toEqual(expect.stringContaining("move-41"));
		expect(readFileSync(join(probe.seen.exportDir ?? "", "probe", "state.json"), "utf8")).toBe('{"tasks":3}\n');
	});

	it("#given an export handler that fails #then the release is refused and the file is not sealed", async () => {
		const probe = probeExtension({ failExport: true });
		await using host = await startReleaseHost(probe.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("state-fails");

		const reply = await host.send({
			type: "release_session",
			id: "rel-move",
			sessionId,
			reason: "move",
			moveId: "move-42",
			target: "laptop",
		});

		expect(reply).toMatchObject({
			success: false,
			error: "release_failed",
			errorData: { detail: expect.stringContaining("probe state is locked") },
		});
		expect(readFileSync(sessionPath, "utf8")).not.toContain(SESSION_RELEASED_ENTRY_TYPE);
	});
});

describe("extension state in the bundle and on import (senpi#3676)", () => {
	it("#given staged extension state #then export bundles it and import leaves it pending for the next open", async () => {
		const { base, cwdB, ledger, readIdentity } = await setup();
		const source = writeSession(join(base, "a2", "repo"));
		const state = join(base, "state-out");
		mkdirSync(join(state, "probe"), { recursive: true });
		writeFileSync(join(state, "probe", "state.json"), '{"tasks":3}\n');
		const bundleDir = join(base, "bundle-state");
		const moveId = "move-0043" as typeof MOVE;
		await ledger.prepare(moveId);
		const manifest = await exportSessionForMove({
			sessionFile: source,
			moveId,
			target: "device-b",
			droppedUserMessages: [],
			bundleDir,
			extensionStateDir: state,
		});
		expect(manifest.payloads).toEqual([
			{ kind: "extension-state", files: [expect.objectContaining({ path: expect.stringContaining("state.json") })] },
		]);

		const { sessionFile } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		const pending = await pendingMovedState(sessionFile);
		expect(pending).toMatchObject({ moveId, dir: movedStateDir(sessionFile, moveId) });
		expect(readFileSync(join(pending?.dir ?? "", "probe", "state.json"), "utf8")).toBe('{"tasks":3}\n');
	});
});

describe("extension state restored on open (senpi#3676)", () => {
	it("#given a moved-in session with pending state #when it is opened #then each extension gets it once and the state is cleared", async () => {
		const probe = probeExtension();
		await using host = await startReleaseHost(probe.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionPath, sessionId } = await host.open("moved-in");
		expect(await host.release(sessionId)).toMatchObject({ success: true });
		const id = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0] ?? "{}").id as string;
		const lines = readFileSync(sessionPath, "utf8").trimEnd().split("\n");
		const last = JSON.parse(lines.at(-1) ?? "{}") as { id: string };
		const movedIn = {
			type: "custom",
			id: "mv-in",
			parentId: last.id,
			timestamp: "2026-10-19T00:00:00.000Z",
			customType: "session_moved_in",
			data: { move_id: "move-44", session_id: id, from: "device-a" },
		};
		writeFileSync(sessionPath, `${[...lines, JSON.stringify(movedIn)].join("\n")}\n`);
		const pendingDir = movedStateDir(sessionPath, "move-44" as typeof MOVE);
		mkdirSync(join(pendingDir, "probe"), { recursive: true });
		writeFileSync(join(pendingDir, "probe", "state.json"), '{"tasks":3}\n');

		expect(await host.attach(sessionPath)).toMatchObject({
			success: true,
			data: { sessionId: expect.not.stringMatching(sessionId) },
		});

		expect(probe.seen.importDir).not.toBe(pendingDir);
		expect(existsSync(probe.seen.importDir ?? "")).toBe(false);
		expect(probe.seen.imported).toBe('{"tasks":3}\n');
		expect(existsSync(pendingDir)).toBe(false);
		expect(customTypes(sessionPath)).toContain(MOVED_STATE_RESTORED);
		expect(await pendingMovedState(sessionPath)).toBeUndefined();
		expect(existsSync(dirname(pendingDir))).toBe(true);
	});
});
