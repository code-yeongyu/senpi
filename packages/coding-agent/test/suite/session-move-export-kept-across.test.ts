/**
 * senpi#6566's custody review: the queued input an export keeps when it fails after the seal must outlive what comes
 * next. A later export may be sent without the list (a caller that restarted no longer has it), and the bundle that
 * takes the kept file's place must never leave that place without a manifest.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { MAX_BUNDLE_PATH_SEGMENTS, MOVE_BUNDLE_FORMAT } from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { SESSION_RELEASED } from "../../src/core/session-move/ownership.ts";
import { appendUserMessage, customTypes, MOVE, root, SESSION_ID, writeSession } from "./session-move-fixture.ts";

// One rename that puts something at the bundle's place fails, as a process that died right there would leave it.
const fsHooks = vi.hoisted(() => ({ failRenameOnto: undefined as ((to: string) => boolean) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rename = (async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
		if (fsHooks.failRenameOnto?.(String(to)) === true) {
			fsHooks.failRenameOnto = undefined;
			throw new Error("the process died here");
		}
		return actual.rename(from, to);
	}) as typeof actual.rename;
	return { ...actual, default: { ...actual, rename }, rename };
});

afterEach(() => {
	fsHooks.failRenameOnto = undefined;
});

const QUEUED = ["queued one", "queued two"];

function world() {
	const base = root();
	mkdirSync(join(base, "a", "repo"), { recursive: true });
	const source = writeSession(join(base, "a", "repo"));
	const bundleDir = join(base, "bundle");
	const exportWith = (extensionStateDir: string | undefined, queued: readonly string[]) =>
		exportSessionForMove({
			sessionFile: source,
			moveId: MOVE,
			target: "device-b",
			droppedUserMessages: queued,
			bundleDir,
			extensionStateDir,
		});
	return { base, source, bundleDir, exportWith };
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

const droppedAt = (bundleDir: string): unknown =>
	(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as { droppedUserMessages?: unknown })
		.droppedUserMessages;

it("#given an export refused after the seal, which kept the queued input #when the move is exported again without the list, as a caller that restarted sends it, and succeeds #then the bundle's manifest still lists the queued input", async () => {
	const { base, source, bundleDir, exportWith } = world();
	sealed(source);
	await expect(exportWith(tooDeep(base), QUEUED)).rejects.toThrow();

	await exportWith(undefined, []);

	expect(existsSync(join(bundleDir, "files", "session.jsonl"))).toBe(true);
	expect(droppedAt(bundleDir)).toEqual(QUEUED);
});

it("#given such kept input #when the bundle that takes its place is stopped at the first step that puts anything there #then the place still holds a manifest that lists the queued input", async () => {
	const { base, source, bundleDir, exportWith } = world();
	sealed(source);
	await expect(exportWith(tooDeep(base), QUEUED)).rejects.toThrow();
	fsHooks.failRenameOnto = (to) => to === bundleDir || to.startsWith(join(bundleDir, sep));

	await expect(exportWith(undefined, QUEUED)).rejects.toThrow("the process died here");

	expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
	expect(droppedAt(bundleDir)).toEqual(QUEUED);
});

it("#given such kept input #when the move is exported again with a list of its own #then the bundle's manifest lists what that call sent: kept input is carried only when a call sends none", async () => {
	const { base, source, bundleDir, exportWith } = world();
	sealed(source);
	await expect(exportWith(tooDeep(base), QUEUED)).rejects.toThrow();

	await exportWith(undefined, ["sent again"]);

	expect(droppedAt(bundleDir)).toEqual(["sent again"]);
});

it("#given such kept input #when the bundle that takes its place is stopped after the place's earlier entries are gone and before its own manifest is there #then the manifest at the place is still the kept one, not one that names files the place does not hold", async () => {
	const { base, source, bundleDir, exportWith } = world();
	sealed(source);
	await expect(exportWith(tooDeep(base), QUEUED)).rejects.toThrow();
	fsHooks.failRenameOnto = (to) => to === join(bundleDir, "files");

	await exportWith(undefined, QUEUED).catch(() => undefined);

	const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as Record<string, unknown>;
	if (manifest.session !== undefined) expect(existsSync(join(bundleDir, "files", "session.jsonl"))).toBe(true);
	expect(manifest.droppedUserMessages).toEqual(QUEUED);
});

it("#given such kept input whose manifest is there and cannot be read, a folder in its place #when the move is exported again without the list #then the export fails, #and the place is as it was: nothing is staged and nothing replaces what is there", async () => {
	const { base, source, bundleDir, exportWith } = world();
	sealed(source);
	await expect(exportWith(tooDeep(base), QUEUED)).rejects.toThrow();
	const manifest = join(bundleDir, "manifest.json");
	rmSync(manifest);
	mkdirSync(manifest);

	await expect(exportWith(undefined, [])).rejects.toThrow();

	expect(readdirSync(bundleDir)).toEqual(["manifest.json"]);
	expect(statSync(manifest).isDirectory()).toBe(true);
	expect(readdirSync(base).filter((name) => name.startsWith("bundle."))).toEqual([]);
});

it("#given a session still writable, and a manifest at the bundle's place that is there and cannot be read, a folder in its place #when the move is exported without the list #then the export fails before the seal: the session has no release entry and can still be written to, #and the place is as it was (senpi#6603)", async () => {
	const { base, source, bundleDir, exportWith } = world();
	const manifest = join(bundleDir, "manifest.json");
	mkdirSync(manifest, { recursive: true });

	await expect(exportWith(undefined, [])).rejects.toThrow();

	expect(customTypes(source)).toEqual([]);
	expect(() => appendUserMessage(source, "still here")).not.toThrow();
	expect(readdirSync(bundleDir)).toEqual(["manifest.json"]);
	expect(statSync(manifest).isDirectory()).toBe(true);
	expect(readdirSync(base).filter((name) => name.startsWith("bundle."))).toEqual([]);
});

it("#given a manifest of another move at the bundle's place #when this move is exported without the list #then the bundle's manifest lists no queued input: another move's input is not this one's", async () => {
	const { source, bundleDir, exportWith } = world();
	sealed(source);
	mkdirSync(bundleDir, { recursive: true });
	const other = { format: MOVE_BUNDLE_FORMAT, moveId: "move-other", droppedUserMessages: ["theirs"] };
	writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(other));

	await exportWith(undefined, []);

	expect(droppedAt(bundleDir)).toEqual([]);
});

it("#given nothing at the bundle's place #when the move is exported without the list #then the bundle's manifest lists no queued input", async () => {
	const { source, bundleDir, exportWith } = world();
	sealed(source);

	await exportWith(undefined, []);

	expect(droppedAt(bundleDir)).toEqual([]);
});
