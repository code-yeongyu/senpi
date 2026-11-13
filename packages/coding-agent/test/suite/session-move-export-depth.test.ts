/**
 * senpi#6469: a path in a move bundle may be at most 32 segments deep, and a receiver refuses a bundle that lists a
 * deeper one. The sender therefore refuses first, before it seals the session, so a session whose files would not fit
 * stays writable. And the sender reads back the bundle it kept without that rule, so a move whose bundle was written
 * before the cap can still be finished, either way.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFileAsync, SessionManager } from "../../src/core/session-manager.ts";
import {
	MAX_BUNDLE_PATH_SEGMENTS,
	MoveBundleInvalidError,
	MovePathTooDeepError,
} from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { SESSION_RELEASED, sessionOwnership } from "../../src/core/session-move/ownership.ts";
import {
	admittedInputs,
	customTypes,
	MOVE,
	REPO,
	root,
	SESSION_ID,
	setup,
	writeSession,
} from "./session-move-fixture.ts";

const folders = (count: number): string[] => Array.from({ length: count }, () => "d");

/** A state folder with one file whose path in the bundle, `state/.../x.json`, has `segments` segments. */
function stateOf(base: string, segments: number): string {
	const dir = join(base, "state-src");
	const folder = join(dir, ...folders(segments - 2));
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "x.json"), "{}\n");
	return dir;
}

function world() {
	const base = root();
	const cwdB = join(base, "b", "repo");
	mkdirSync(join(base, "a", "repo"), { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const source = writeSession(join(base, "a", "repo"));
	const bundleDir = join(base, "bundle");
	const exportWith = (extensionStateDir: string | (() => string) | undefined) =>
		exportSessionForMove({
			sessionFile: source,
			moveId: MOVE,
			target: "device-b",
			droppedUserMessages: [],
			bundleDir,
			extensionStateDir,
		});
	return { base, cwdB, source, bundleDir, exportWith };
}

const writable = async (file: string) => sessionOwnership(await loadEntriesFromFileAsync(file)).writable;
const bundleFolders = (base: string) => readdirSync(base).filter((name) => name.startsWith("bundle"));

describe("a move's export and the depth a bundle path may have (senpi#6469)", () => {
	it("#given extension state whose deepest file is exactly as deep as a bundle path may be #when the session is exported and the bundle imported #then both take it and the session lands", async () => {
		const { base, cwdB, bundleDir, exportWith } = world();

		await exportWith(stateOf(base, MAX_BUNDLE_PATH_SEGMENTS));
		const ledger = new MoveLedger(join(base, "ledger-b"));
		await ledger.prepare(MOVE);
		const landed = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity: async () => REPO });

		expect(existsSync(landed.sessionFile)).toBe(true);
	});

	it("#given extension state one folder deeper than a bundle path may be #when the session is exported #then it is refused before the seal: the session stays writable with no release entry, and no bundle or partial bundle is written", async () => {
		const { base, source, exportWith } = world();

		const refused = exportWith(stateOf(base, MAX_BUNDLE_PATH_SEGMENTS + 1));

		await expect(refused).rejects.toBeInstanceOf(MovePathTooDeepError);
		expect(await writable(source)).toBe(true);
		expect(customTypes(source)).toEqual([]);
		expect(bundleFolders(base)).toEqual([]);
	});

	it("#given a resident blob of the session one folder deeper than a bundle path may be #when the session is exported #then it is refused before the seal in the same way", async () => {
		const { base, source, exportWith } = world();
		// `files/resident-blobs/<session>/` is three segments and the file name one.
		const blobs = join(dirname(source), "resident-blobs", SESSION_ID, ...folders(MAX_BUNDLE_PATH_SEGMENTS - 3));
		mkdirSync(blobs, { recursive: true });
		writeFileSync(join(blobs, "b.blob"), "blob");

		const refused = exportWith(undefined);

		await expect(refused).rejects.toBeInstanceOf(MovePathTooDeepError);
		expect(await writable(source)).toBe(true);
		expect(customTypes(source)).toEqual([]);
		expect(bundleFolders(base)).toEqual([]);
	});

	it("#given a session already sealed for the move with staged state too deep, as an earlier version's release leaves it #when it is exported #then no bundle is written, and finish with a declined answer takes the session back", async () => {
		const { base, source, bundleDir, exportWith } = world();
		SessionManager.open(source).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: MOVE,
			session_id: SESSION_ID,
			target: "device-b",
			released_at: "2026-11-12T00:00:00.000Z",
		});
		const staged = stateOf(base, MAX_BUNDLE_PATH_SEGMENTS + 1);

		const refused = exportWith(() => staged);

		await expect(refused).rejects.toBeInstanceOf(MovePathTooDeepError);
		expect(bundleFolders(base)).toEqual([]);
		await finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(await writable(source)).toBe(true);
	});
});

/** A bundle as a version before the cap wrote it: its manifest lists extension state one folder too deep. */
async function keptBundleFromBeforeTheCap() {
	const made = await setup();
	const path = `state/${"d/".repeat(MAX_BUNDLE_PATH_SEGMENTS - 1)}x.json`;
	mkdirSync(dirname(join(made.bundleDir, path)), { recursive: true });
	writeFileSync(join(made.bundleDir, path), "{}\n");
	const file = join(made.bundleDir, "manifest.json");
	const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
	const payloads = [{ kind: "extension-state", files: [{ path, sha256: "0".repeat(64) }] }];
	writeFileSync(file, JSON.stringify({ ...Object(manifest), payloads }));
	return made;
}

describe("the sender finishes a move whose kept bundle lists a path deeper than the cap (senpi#6469)", () => {
	it("#given a declined answer #when the sender finishes #then the session is taken back writable with its queued input, and the bundle is gone", async () => {
		const { source, bundleDir } = await keptBundleFromBeforeTheCap();

		await finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});

		expect(await writable(source)).toBe(true);
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given a kept bundle in a format this version does not know, its queued input intact #when the sender finishes #then it is refused: nothing is put back, the session stays sealed and the bundle stays", async () => {
		const { source, bundleDir } = await setup();
		const file = join(bundleDir, "manifest.json");
		const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...Object(manifest), format: 2 }));

		const refused = finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(await writable(source)).toBe(false);
		expect(admittedInputs(source)).toEqual([]);
		expect(existsSync(bundleDir)).toBe(true);
	});

	it("#given an accepted answer #when the sender finishes #then the session is marked moved and the bundle is gone", async () => {
		const { source, bundleDir } = await keptBundleFromBeforeTheCap();

		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer: { state: "accepted" } });

		expect(customTypes(source)).toContain("session_moved");
		expect(await writable(source)).toBe(false);
		expect(existsSync(bundleDir)).toBe(false);
	});
});
