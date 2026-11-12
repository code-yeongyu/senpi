/**
 * senpi#6542: a move's export that fails after the session is sealed. The input the release took out of the session
 * lived in one place, the bundle's manifest, so an export that wrote no bundle left it in no file, and a `declined`
 * finish took the session back without it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFileAsync, SessionManager } from "../../src/core/session-manager.ts";
import {
	MAX_BUNDLE_PATH_SEGMENTS,
	MOVE_BUNDLE_FORMAT,
	MoveBundleInvalidError,
	MovePathTooDeepError,
	readManifest,
} from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove, MovedStateMissingError } from "../../src/core/session-move/export.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { SESSION_RELEASED, sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { admittedInputs, MOVE, root, SESSION_ID, writeSession } from "./session-move-fixture.ts";

const QUEUED = ["queued one", "queued two"];

function world() {
	const base = root();
	mkdirSync(join(base, "a", "repo"), { recursive: true });
	const source = writeSession(join(base, "a", "repo"));
	const bundleDir = join(base, "bundle");
	const exportWith = (extensionStateDir: string | (() => string) | undefined, queued: readonly string[] = QUEUED) =>
		exportSessionForMove({
			sessionFile: source,
			moveId: MOVE,
			target: "device-b",
			droppedUserMessages: queued,
			bundleDir,
			extensionStateDir,
		});
	const declined = () =>
		finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer: { state: "declined", reason: "cancelled" } });
	return { base, source, bundleDir, exportWith, declined };
}

/** A state folder with one file whose path in the bundle is one segment deeper than a bundle path may be. */
function tooDeep(base: string): string {
	const dir = join(base, "state-src");
	const folder = join(dir, ...Array.from({ length: MAX_BUNDLE_PATH_SEGMENTS - 1 }, () => "d"));
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "x.json"), "{}\n");
	return dir;
}

/** The session as a release leaves it: sealed for the move, before any export. */
function sealed(source: string): void {
	SessionManager.open(source).appendCustomEntry(SESSION_RELEASED, {
		reason: "move",
		move_id: MOVE,
		session_id: SESSION_ID,
		target: "device-b",
		released_at: "2026-11-12T00:00:00.000Z",
	});
}

const writable = async (file: string) => sessionOwnership(await loadEntriesFromFileAsync(file)).writable;
const manifestOf = (bundleDir: string): unknown => JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));

describe("an export that fails after the session is sealed keeps the queued input (senpi#6542)", () => {
	it("#given a session sealed for the move with queued input, whose export is refused for staged state too deep #when the move is finished as declined #then the session is writable again and the queued input is back in it, once", async () => {
		const { base, source, exportWith, declined } = world();
		sealed(source);
		const staged = tooDeep(base);

		await expect(exportWith(() => staged)).rejects.toBeInstanceOf(MovePathTooDeepError);
		await declined();
		await declined();

		expect(await writable(source)).toBe(true);
		expect(admittedInputs(source)).toEqual(QUEUED);
	});

	it("#given the same session whose staged state folder is no longer on disk #when the move is finished as declined #then the queued input is back in it", async () => {
		const { base, source, exportWith, declined } = world();
		sealed(source);

		await expect(exportWith(() => join(base, "state-that-is-gone"))).rejects.toBeInstanceOf(MovedStateMissingError);
		await declined();

		expect(await writable(source)).toBe(true);
		expect(admittedInputs(source)).toEqual(QUEUED);
	});

	it("#given a writable session whose state folder is given as a function, which is asked only after the seal #when the export is refused for state too deep #then the session is sealed, and a declined finish takes it back with the queued input", async () => {
		const { base, source, exportWith, declined } = world();
		const staged = tooDeep(base);

		await expect(exportWith(() => staged)).rejects.toBeInstanceOf(MovePathTooDeepError);
		expect(await writable(source)).toBe(false);
		await declined();

		expect(await writable(source)).toBe(true);
		expect(admittedInputs(source)).toEqual(QUEUED);
	});

	it("#given such a refused export #then what is kept holds the move and the queued input and nothing else, #and a receiver's reader refuses it as a bundle", async () => {
		const { base, source, bundleDir, exportWith } = world();
		sealed(source);
		const staged = tooDeep(base);

		await expect(exportWith(() => staged)).rejects.toBeInstanceOf(MovePathTooDeepError);

		expect(manifestOf(bundleDir)).toEqual({ format: MOVE_BUNDLE_FORMAT, moveId: MOVE, droppedUserMessages: QUEUED });
		expect(existsSync(join(bundleDir, "files"))).toBe(false);
		await expect(readManifest(bundleDir)).rejects.toBeInstanceOf(MoveBundleInvalidError);
	});

	it("#given no queued input #when the export is refused after the seal #then nothing is kept", async () => {
		const { base, source, bundleDir, exportWith } = world();
		sealed(source);
		const staged = tooDeep(base);

		await expect(exportWith(() => staged, [])).rejects.toBeInstanceOf(MovePathTooDeepError);

		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given an earlier export's bundle is already there #when a second export of the move is refused #then that bundle is left as it was", async () => {
		const { base, bundleDir, exportWith } = world();
		await exportWith(undefined);
		const before = readFileSync(join(bundleDir, "manifest.json"), "utf8");
		const staged = tooDeep(base);

		await expect(exportWith(() => staged, ["another"])).rejects.toBeInstanceOf(MovePathTooDeepError);

		expect(readFileSync(join(bundleDir, "manifest.json"), "utf8")).toBe(before);
		expect(existsSync(join(bundleDir, "files", "session.jsonl"))).toBe(true);
	});

	it("#given a session sealed for the move with queued input #when the export succeeds #then the bundle is there whole, with the queued input in its manifest", async () => {
		const { source, bundleDir, exportWith } = world();
		sealed(source);

		await exportWith(undefined);

		expect((await readManifest(bundleDir)).droppedUserMessages).toEqual(QUEUED);
		expect(existsSync(join(bundleDir, "files", "session.jsonl"))).toBe(true);
	});
});
