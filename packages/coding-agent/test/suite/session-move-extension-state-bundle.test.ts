/**
 * The `extension-state` payload on the receiving side (senpi#3681 review): its files must sit under `state/`, and
 * what is placed next to the session is the staged copy that was checked, never a re-read of the bundle.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MANIFEST_FILE, MoveBundleInvalidError, readManifest } from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { movedStateDir } from "../../src/core/session-move/extension-state.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { REPO, setup, writeSession } from "./session-move-fixture.ts";

async function bundleWithState(moveId: MoveId) {
	const rig = await setup();
	const source = writeSession(join(rig.base, "a2", "repo"));
	const state = join(rig.base, "state-out");
	mkdirSync(join(state, "probe"), { recursive: true });
	writeFileSync(join(state, "probe", "state.json"), '{"tasks":3}\n');
	const bundleDir = join(rig.base, "bundle-state");
	await rig.ledger.prepare(moveId);
	await exportSessionForMove({
		sessionFile: source,
		moveId,
		target: "device-b",
		droppedUserMessages: [],
		bundleDir,
		extensionStateDir: state,
	});
	return { ...rig, source, bundleDir };
}

describe("extension-state payload paths (senpi#3681 review)", () => {
	it("#given an extension-state file listed outside state/ #when the manifest is read #then the bundle is refused", async () => {
		const { bundleDir } = await bundleWithState("move-71" as MoveId);
		const manifestPath = join(bundleDir, MANIFEST_FILE);
		const manifest: { payloads: { files: { path: string }[] }[] } = JSON.parse(readFileSync(manifestPath, "utf8"));
		const file = manifest.payloads[0]?.files[0];
		if (file === undefined) throw new Error("the bundle carries no extension state");
		mkdirSync(join(bundleDir, "files", "probe"), { recursive: true });
		renameSync(join(bundleDir, file.path), join(bundleDir, "files", "probe", "state.json"));
		file.path = "files/probe/state.json";
		writeFileSync(manifestPath, JSON.stringify(manifest));

		await expect(readManifest(bundleDir)).rejects.toThrow(MoveBundleInvalidError);
	});
});

describe("extension-state placement on import (senpi#3681 review)", () => {
	it("#given a payload file changed after the bundle was verified #when it is imported #then the change is refused and never placed", async () => {
		const moveId = "move-72" as MoveId;
		const { bundleDir, cwdB, ledger, source } = await bundleWithState(moveId);
		const payloadPath = join(bundleDir, "state", "probe", "state.json");
		const readIdentity = async () => {
			writeFileSync(payloadPath, '{"tasks":"tampered"}\n');
			return REPO;
		};

		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toMatchObject({
			code: "move_bundle_invalid",
		});

		const target = join(getDefaultSessionDir(cwdB), source.split("/").at(-1) ?? "");
		expect(existsSync(join(movedStateDir(target, moveId), "probe", "state.json"))).toBe(false);
		expect(await ledger.answerStatus(moveId, { movedIn: false })).toMatchObject({
			state: "failed",
			reason: "bundle_invalid",
		});
	});
});
