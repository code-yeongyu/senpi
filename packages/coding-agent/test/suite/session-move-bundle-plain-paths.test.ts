/**
 * What classifies a bundle's listed files reads their paths as text, and what moves them reads the disk. A "." or an
 * empty segment names the same file another way, so the two can disagree about which file a path is. A listed path
 * with such a segment is refused where ".." is: at the manifest's parser, the one place every later reader rests on
 * (the custody reviews of senpi#6571 and senpi#6445).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError, parseManifest } from "../../src/core/session-move/bundle.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { SESSION_ID, setup } from "./session-move-fixture.ts";

interface Listing {
	sessionFileName: string;
	sidecars: { path: string; sha256: string }[];
}
const BYTES = '{"goal":"another"}\n';

/** The fixture's own bundle with one more sidecar listed at `path`, and the file written where that path leads. */
async function bundleListing(path: (listing: Listing) => string) {
	const world = await setup();
	const file = join(world.bundleDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as Listing;
	const listed = path(manifest);
	mkdirSync(dirname(join(world.bundleDir, listed)), { recursive: true });
	writeFileSync(join(world.bundleDir, listed), BYTES);
	const sha256 = createHash("sha256").update(BYTES).digest("hex");
	manifest.sidecars = [...manifest.sidecars, { path: listed, sha256 }];
	writeFileSync(file, JSON.stringify(manifest));
	return { ...world, manifestText: JSON.stringify(manifest) };
}

describe("a bundle's listed paths are plain", () => {
	it.each([
		["a '.' segment under an extension's folder", () => `files/extensions/./x/${SESSION_ID}.json`],
		["an empty segment", () => `files/extensions//x/${SESSION_ID}.json`],
		["the session file's own name behind a '.' segment", (listing: Listing) => `files/./${listing.sessionFileName}`],
		["a '.' segment written with the other separator", () => `files\\.\\extensions\\x\\${SESSION_ID}.json`],
	])("#given a manifest that lists %s #then it is refused as an invalid bundle", async (_what, path) => {
		const { manifestText } = await bundleListing(path);

		expect(() => parseManifest(manifestText)).toThrow(MoveBundleInvalidError);
	});

	it("#given a manifest that lists a plain path under an extension's folder #then it is read, with that path as written", async () => {
		const plain = `files/extensions/x/${SESSION_ID}.json`;
		const { manifestText } = await bundleListing(() => plain);

		expect(parseManifest(manifestText).sidecars.map((item) => item.path)).toContain(plain);
	});

	it("#given a bundle whose manifest lists a '.' segment under an extension's folder #when it is imported #then the import is refused as an invalid bundle, #and that file does not land", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await bundleListing(
			() => `files/extensions/./x/${SESSION_ID}.json`,
		);

		const refused = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(existsSync(join(getDefaultSessionDir(cwdB), "extensions", "x", `${SESSION_ID}.json`))).toBe(false);
	});
});
