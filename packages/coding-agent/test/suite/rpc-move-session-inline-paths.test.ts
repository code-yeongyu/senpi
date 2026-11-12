/**
 * `move_session import` with `files` (senpi#6267): what a sent path may be. Every sent file must be one the manifest
 * lists, at a path that stays inside the bundle and can be a file where the bundle is staged. Anything else is refused
 * `move_bundle_invalid` before a folder is made or a byte is written, and the move stays importable.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { move } from "./rpc-move-session-support.ts";
import {
	exported,
	filesUnder,
	type InlineFile,
	inlineFile,
	inlineOf,
	landedOn,
	stagedOn,
	withListed,
} from "./rpc-move-session-inline-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const BYTES = Buffer.from("not part of the session\n");

/** The bundle with these paths sent and listed in its manifest: the manifest agrees, so only the path can be wrong. */
const listed =
	(...paths: string[]) =>
	(files: InlineFile[]) =>
		withListed(files, ...paths.map((path) => inlineFile(path, BYTES)));

describe("move_session import with files: the paths it takes (senpi#6267)", () => {
	it.each([
		["a parent segment", () => "../escaped.txt"],
		["a parent segment below the bundle", () => "files/../../escaped.txt"],
		["a backslash parent segment", () => "..\\escaped.txt"],
		["a drive path", () => "C:\\escaped.txt"],
		["an absolute path", (base: string) => join(base, "escaped.txt")],
	])(
		"#given a file whose path leaves the bundle by %s #then import refuses it and writes nothing there",
		async (_case, pathIn) => {
			const { fixture, a, b, reply } = await exported("move-i4");
			await using _a = a;
			await using _b = b;
			const stray = inlineFile(pathIn(fixture.base), Buffer.from("out of the bundle\n"));

			const refused = await move(b, { op: "import", files: [...inlineOf(reply), stray], cwd: fixture.repoB });

			expect(refused).toMatchObject({ success: false, errorCode: "move_bundle_invalid" });
			expect(filesUnder(fixture.base).filter((path) => path.includes("escaped"))).toEqual([]);
			expect(existsSync(landedOn(fixture))).toBe(false);
			expect(stagedOn(fixture.agentB)).toEqual([]);
		},
	);

	it.each<[string, (files: InlineFile[]) => InlineFile[]]>([
		[
			"a file the manifest does not list, under folders forty deep",
			(files) => [
				...files,
				{ path: `${"d/".repeat(40)}extra.bin`, sha256: "nope", base64: BYTES.toString("base64") },
			],
		],
		["a listed path with a dot segment after a backslash", listed("files\\.\\x")],
		["a listed path with an empty segment after a backslash", listed("files\\\\x")],
		["a listed path with a NUL character", listed("files/a\0b")],
		["a listed path with a segment longer than a file name may be", listed(`files/${"n".repeat(256)}`)],
		["a listed path longer than a sent path may be", listed(`files/${"ab/".repeat(400)}x`)],
		["a listed path that is both a file and another file's folder", listed("files/x", "files/x/y")],
	])(
		"#given %s #then import refuses move_bundle_invalid before a folder is made and the move stays importable",
		async (_case, tamper) => {
			const { fixture, a, b, reply } = await exported("move-p1");
			await using _a = a;
			await using _b = b;

			const refused = await move(b, { op: "import", files: tamper(inlineOf(reply)), cwd: fixture.repoB });

			expect(refused).toMatchObject({ success: false, errorCode: "move_bundle_invalid" });
			expect(existsSync(join(fixture.agentB, "session-moves", "incoming"))).toBe(false);
			expect(existsSync(landedOn(fixture))).toBe(false);
			expect((await move(b, { op: "status", moveId: "move-p1" })).data).toEqual({ state: "receiving" });
			expect(await move(b, { op: "import", files: inlineOf(reply), cwd: fixture.repoB })).toMatchObject({
				success: true,
				data: { session_id: SESSION_ID },
			});
		},
	);
});
