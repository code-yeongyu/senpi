/**
 * The receiver's parser refuses a listed path that leaves the bundle or has a "." or an empty segment, under either
 * separator. Off Windows a backslash is an ordinary character of a name, so a file named `a\.\b.json` is listed under
 * such a path. The sender refuses first, as it does for a path too deep (senpi#6469): before it seals the session
 * where it still can, and before it writes a bundle where the session was sealed already. The refusal names the file.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFileAsync, SessionManager } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { SESSION_RELEASED, sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { customTypes, MOVE, REPO, root, SESSION_ID, writeSession } from "./session-move-fixture.ts";

/** A state folder with one file of this name, listed in a bundle as `state/probe/<name>`. */
function stateWith(base: string, name: string): string {
	const dir = join(base, "state-src");
	mkdirSync(join(dir, "probe"), { recursive: true });
	writeFileSync(join(dir, "probe", name), "{}\n");
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
/** The refusal, naming the path the file would be listed under. */
const refusalNaming = (listed: string) => ({
	code: "move_path_not_plain",
	message: expect.stringContaining(JSON.stringify(listed)),
});

/** Where the odd name is put; answers the state folder to export with, if it put it there. */
type Place = (base: string, source: string) => string | undefined;
const inState =
	(name: string): Place =>
	(base) =>
		stateWith(base, name);
const asSidecarFolder: Place = (_base, source) => {
	const folder = join(dirname(source), "extensions", "x\\.\\y");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${SESSION_ID}.json`), "{}\n");
	return undefined;
};
const asResidentBlob: Place = (_base, source) => {
	const folder = join(dirname(source), "resident-blobs", SESSION_ID);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "b\\\\c.blob"), "blob");
	return undefined;
};

// A backslash is an ordinary character of a name only off Windows, where the export then lists it as it is.
describe.skipIf(process.platform === "win32")("a move's export and a name a bundle cannot list", () => {
	it.each<[string, Place, string]>([
		["extension state holding a file named a\\.\\b.json", inState("a\\.\\b.json"), "state/probe/a\\.\\b.json"],
		["extension state holding a file named a\\..\\b.json", inState("a\\..\\b.json"), "state/probe/a\\..\\b.json"],
		["an extension's sidecar folder named x\\.\\y", asSidecarFolder, `files/extensions/x\\.\\y/${SESSION_ID}.json`],
		["a resident blob named b\\\\c.blob", asResidentBlob, `files/resident-blobs/${SESSION_ID}/b\\\\c.blob`],
	])(
		"#given %s #when the session is exported #then it is refused before the seal, naming the file: the session stays writable with no release entry, and no bundle or partial bundle is written",
		async (_what, place, listed) => {
			const { base, source, exportWith } = world();

			const refused = exportWith(place(base, source));

			await expect(refused).rejects.toMatchObject(refusalNaming(listed));
			expect(await writable(source)).toBe(true);
			expect(customTypes(source)).toEqual([]);
			expect(bundleFolders(base)).toEqual([]);
		},
	);

	it.each(["a\\.\\b.json", "a\\..\\b.json"])(
		"#given a session already sealed for the move whose staged state holds a file named %s, as an earlier version's release leaves it #when it is exported #then it is refused naming the file and no bundle is written, #and finish with a declined answer takes the session back",
		async (name) => {
			const { base, source, bundleDir, exportWith } = world();
			SessionManager.open(source).appendCustomEntry(SESSION_RELEASED, {
				reason: "move",
				move_id: MOVE,
				session_id: SESSION_ID,
				target: "device-b",
				released_at: "2026-11-13T00:00:00.000Z",
			});
			const staged = stateWith(base, name);

			const refused = exportWith(() => staged);

			await expect(refused).rejects.toMatchObject(refusalNaming(`state/probe/${name}`));
			expect(bundleFolders(base)).toEqual([]);
			await finishMove({
				sessionFile: source,
				bundleDir,
				moveId: MOVE,
				answer: { state: "declined", reason: "cancelled" },
			});
			expect(await writable(source)).toBe(true);
		},
	);

	it("#given extension state holding a file named a\\b.json, a backslash that makes no such segment #when the session is exported and the bundle imported #then both take it and the session lands", async () => {
		const { base, cwdB, bundleDir, exportWith } = world();

		await exportWith(stateWith(base, "a\\b.json"));
		const ledger = new MoveLedger(join(base, "ledger-b"));
		await ledger.prepare(MOVE);
		const landed = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity: async () => REPO });

		expect(existsSync(landed.sessionFile)).toBe(true);
	});
});
