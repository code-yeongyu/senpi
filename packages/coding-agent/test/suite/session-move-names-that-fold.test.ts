/**
 * A move bundle with two paths that are one name where names fold (senpi#6472), in both forms of the import. Whether
 * a file system folds names is asked of the folder the files are written under; these tests say what it answers, so
 * they hold on a host that folds names and on one that keeps them apart. The two files carry the same bytes for the
 * same reason: on a host that folds them they are one file, and the bundle still verifies.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { withStagedInlineBundle } from "../../src/core/session-move/inline-bundle.ts";
import type { NameFolding } from "../../src/core/session-move/name-folding.ts";
import { exported, inlineFile, inlineOf, landedOn, withListed } from "./rpc-move-session-inline-support.ts";
import { move } from "./rpc-move-session-support.ts";
import { MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";

const FOLDS: NameFolding = { letterCase: true, unicodeForm: true };
const APART: NameFolding = { letterCase: false, unicodeForm: false };
const BYTES = Buffer.from("the same bytes under both names\n");
const PAIR = ["files/Notes.txt", "files/notes.txt"] as const;
const pairInline = () => PAIR.map((path) => inlineFile(path, BYTES));

/** What this host's file system does with the two names, asked without the probe: one file, or two. */
const HOST_FOLDS = (() => {
	const folder = mkdtempSync(join(tmpdir(), "senpi-host-folds-"));
	try {
		writeFileSync(join(folder, "Notes.txt"), "");
		writeFileSync(join(folder, "notes.txt"), "");
		return readdirSync(folder).length === 1;
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
})();

describe("an inline bundle with two paths that are one name where names fold (senpi#6472)", () => {
	it("#given a staging folder whose file system folds names #then the list is refused as an invalid bundle, nothing is staged and the bundle is never read", async () => {
		const { fixture, a, b, reply } = await exported("move-n1");
		await using _a = a;
		await using _b = b;
		const incoming = join(fixture.base, "incoming");
		const use = vi.fn(async () => "used");

		const refused = withStagedInlineBundle(
			withListed(inlineOf(reply), ...pairInline()),
			incoming,
			use,
			async () => FOLDS,
		);

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(use).not.toHaveBeenCalled();
		expect(readdirSync(incoming)).toEqual([]);
	});

	it("#given a staging folder whose file system keeps them apart #then the list is staged and handed on with both paths", async () => {
		const { fixture, a, b, reply } = await exported("move-n2");
		await using _a = a;
		await using _b = b;
		const handedOn: string[] = [];

		const used = await withStagedInlineBundle(
			withListed(inlineOf(reply), ...pairInline()),
			join(fixture.base, "incoming"),
			async (_bundleDir, sent) => {
				handedOn.push(...sent.keys());
				return "used";
			},
			async () => APART,
		);

		expect(used).toBe("used");
		expect(handedOn).toEqual(expect.arrayContaining([...PAIR]));
	});
});

describe("a bundle folder whose manifest lists two paths that are one name where names fold (senpi#6472)", () => {
	async function bundleWithThePair() {
		const world = await setup();
		for (const path of PAIR) {
			mkdirSync(dirname(join(world.bundleDir, path)), { recursive: true });
			writeFileSync(join(world.bundleDir, path), BYTES);
		}
		const file = join(world.bundleDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(file, "utf8")) as { sidecars: { path: string; sha256: string }[] };
		const sha256 = createHash("sha256").update(BYTES).digest("hex");
		manifest.sidecars = [...manifest.sidecars, ...PAIR.map((path) => ({ path, sha256 }))];
		writeFileSync(file, JSON.stringify(manifest));
		return world;
	}

	it("#given a session folder whose file system folds names #then the import is refused as an invalid bundle with the move's record untouched and nothing staged #and the same bundle lands where the names are kept apart", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await bundleWithThePair();
		const record = join(ledger.dir, `${MOVE}.json`);
		const before = existsSync(record) ? readFileSync(record, "utf8") : undefined;
		const importing = { bundleDir, targetCwd: cwdB, ledger, readIdentity };

		const refused = importMovedSession({ ...importing, probeNameFolding: async () => FOLDS });

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(existsSync(record) ? readFileSync(record, "utf8") : undefined).toBe(before);
		expect(existsSync(join(getDefaultSessionDir(cwdB), ".move-staging"))).toBe(false);
		const landed = await importMovedSession({ ...importing, probeNameFolding: async () => APART });
		expect(existsSync(landed.sessionFile)).toBe(true);
	});
});

describe("move_session import with files, on this host's own file system (senpi#6472)", () => {
	it.skipIf(HOST_FOLDS)(
		"#given a host whose file system keeps the two names apart #then the import takes the list and the session lands",
		async () => {
			const { fixture, a, b, reply } = await exported("move-n3");
			await using _a = a;
			await using _b = b;

			const imported = await move(b, {
				op: "import",
				files: withListed(inlineOf(reply), ...pairInline()),
				cwd: fixture.repoB,
			});

			expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
			expect(existsSync(landedOn(fixture))).toBe(true);
		},
	);

	it.skipIf(!HOST_FOLDS)(
		"#given a host whose file system folds the two names #then the import refuses move_bundle_invalid and the move stays importable",
		async () => {
			const { fixture, a, b, reply } = await exported("move-n4");
			await using _a = a;
			await using _b = b;

			const refused = await move(b, {
				op: "import",
				files: withListed(inlineOf(reply), ...pairInline()),
				cwd: fixture.repoB,
			});

			expect(refused).toMatchObject({ success: false, errorCode: "move_bundle_invalid" });
			expect(existsSync(landedOn(fixture))).toBe(false);
			expect((await move(b, { op: "status", moveId: "move-n4" })).data).toEqual({ state: "receiving" });
			expect(await move(b, { op: "import", files: inlineOf(reply), cwd: fixture.repoB })).toMatchObject({
				success: true,
				data: { session_id: SESSION_ID },
			});
		},
	);
});
