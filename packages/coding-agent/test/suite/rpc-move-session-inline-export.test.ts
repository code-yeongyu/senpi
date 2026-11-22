/**
 * `move_session export` with `inline` (senpi#6267): the answer carries the bundle's files beside its folder when the
 * bundle fits the cap, so a move between two hosts needs no file transfer of its own. A bundle over the cap, and a caller
 * that does not ask, get the answer they got before.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { move } from "./rpc-move-session-support.ts";
import {
	bytesOf,
	exported,
	filesUnder,
	inlineOf,
	landedOn,
	SIDECAR_FILE,
	sha256,
} from "./rpc-move-session-inline-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

describe("move_session export with inline (senpi#6267)", () => {
	it("#given inline asked #when the bundle fits the cap #then export answers every bundle file beside the folder answer", async () => {
		const { a, b, reply } = await exported("move-i1");
		await using _a = a;
		await using _b = b;

		expect(reply).toMatchObject({ success: true, data: { move_id: "move-i1", session_id: SESSION_ID, files: 2 } });
		const { bundle_dir: bundleDir } = reply.data as { bundle_dir: string };
		const files = inlineOf(reply);
		expect(files[0]?.path).toBe("manifest.json");
		expect(files.map((file) => file.path).sort()).toEqual(filesUnder(bundleDir));
		expect(files.map((file) => file.path)).toContain(SIDECAR_FILE);
		for (const file of files) {
			expect(bytesOf(file).equals(readFileSync(join(bundleDir, file.path)))).toBe(true);
			expect(file.sha256).toBe(sha256(bytesOf(file)));
		}
	});

	it("#given a caller cap #then a bundle that fits it comes inline and one byte less gets the folder answer", async () => {
		const { a, b, again, reply } = await exported("move-i5", {});
		await using _a = a;
		await using _b = b;
		const { bundle_dir: bundleDir } = reply.data as { bundle_dir: string };
		const total = filesUnder(bundleDir).reduce((sum, path) => sum + statSync(join(bundleDir, path)).size, 0);

		const fits = await again({ inline: true, inlineMaxBytes: total });
		const over = await again({ inline: true, inlineMaxBytes: total - 1 });

		expect(
			inlineOf(fits)
				.map((file) => file.path)
				.sort(),
		).toEqual(filesUnder(bundleDir));
		expect(over).toMatchObject({ success: true });
		expect(Object.keys(over.data as object)).toEqual(["move_id", "session_id", "bundle_dir", "files"]);
		expect(existsSync(join((over.data as { bundle_dir: string }).bundle_dir, "manifest.json"))).toBe(true);
	});

	it("#given a bundle over the engine's 1 MiB cap #then export answers the folder only, whatever the caller's cap", async () => {
		const { a, b, reply } = await exported(
			"move-i6",
			{ inline: true, inlineMaxBytes: 64 * 1024 * 1024 },
			1024 * 1024,
		);
		await using _a = a;
		await using _b = b;

		expect(reply).toMatchObject({ success: true, data: { move_id: "move-i6" } });
		expect(Object.keys(reply.data as object)).toEqual(["move_id", "session_id", "bundle_dir", "files"]);
	});

	it("#given a caller that asks for nothing new #then export and import answer byte for byte as before", async () => {
		const { fixture, a, b, reply } = await exported("move-i7", {});
		await using _a = a;
		await using _b = b;
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-i7");
		const response = { id: "mv", type: "response", command: "move_session", success: true };

		expect(JSON.stringify(reply)).toBe(
			JSON.stringify({
				...response,
				data: { move_id: "move-i7", session_id: SESSION_ID, bundle_dir: bundleDir, files: 2 },
			}),
		);
		const imported = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });
		expect(JSON.stringify(imported)).toBe(
			JSON.stringify({ ...response, data: { session_id: SESSION_ID, session_path: landedOn(fixture) } }),
		);
	});
});
