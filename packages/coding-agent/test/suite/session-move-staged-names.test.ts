/**
 * senpi#6523's review: the check for names that fold compared a bundle's paths as the bundle lists them. A staged
 * move writes other names: the session under its own file name beside the sidecars, the payloads under one folder of
 * the staging's own. A clash that exists only among those names was not seen.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError, parseManifest } from "../../src/core/session-move/bundle.ts";
import { EXTENSION_STATE_PAYLOAD } from "../../src/core/session-move/extension-state.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { type NameFolding, probeNameFolding } from "../../src/core/session-move/name-folding.ts";
import { STAGED_PAYLOADS, stagedNames } from "../../src/core/session-move/staged-layout.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

const FOLDS: NameFolding = { letterCase: true, unicodeForm: true };
const APART: NameFolding = { letterCase: false, unicodeForm: false };
const BYTES = Buffer.from("a sidecar\n");

/** A bundle folder with one more sidecar, `files/<name>`. */
async function bundleWithSidecar(name: (sessionFileName: string) => string) {
	const world = await setup();
	const file = join(world.bundleDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as {
		sessionFileName: string;
		sidecars: { path: string; sha256: string }[];
	};
	const path = `files/${name(manifest.sessionFileName)}`;
	writeFileSync(join(world.bundleDir, path), BYTES);
	manifest.sidecars = [...manifest.sidecars, { path, sha256: createHash("sha256").update(BYTES).digest("hex") }];
	writeFileSync(file, JSON.stringify(manifest));
	return world;
}

/** A bundle with a payload file `state/x.json` and a sidecar `files/<STAGED_PAYLOADS>/state/x.json`: one staged name. */
async function bundleWithPayloadTwin() {
	const world = await setup();
	const file = join(world.bundleDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as {
		sidecars: { path: string; sha256: string }[];
		payloads: { kind: string; files: { path: string; sha256: string }[] }[];
	};
	const sha256 = createHash("sha256").update(BYTES).digest("hex");
	const payloadPath = "state/x.json";
	const sidecarPath = `files/${STAGED_PAYLOADS}/${payloadPath}`;
	for (const path of [payloadPath, sidecarPath]) {
		mkdirSync(dirname(join(world.bundleDir, path)), { recursive: true });
		writeFileSync(join(world.bundleDir, path), BYTES);
	}
	manifest.payloads = [
		...manifest.payloads,
		{ kind: EXTENSION_STATE_PAYLOAD, files: [{ path: payloadPath, sha256 }] },
	];
	manifest.sidecars = [...manifest.sidecars, { path: sidecarPath, sha256 }];
	writeFileSync(file, JSON.stringify(manifest));
	return world;
}

describe("the names a staged move writes, and names that fold (senpi#6523's review)", () => {
	it("#given a sidecar named as the session file in another letter case #and a session folder whose file system folds names #then the import is refused as an invalid bundle, the move's record untouched and nothing staged #and the same bundle lands where names are kept apart", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await bundleWithSidecar((sessionFileName) =>
			sessionFileName.toUpperCase(),
		);
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

	it("#given a sidecar listed as files/<the session file's own name> #then the import is refused as an invalid bundle before the move's record is touched: once staged, two different files would be one name", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await bundleWithSidecar((sessionFileName) => sessionFileName);
		const record = join(ledger.dir, `${MOVE}.json`);
		const before = existsSync(record) ? readFileSync(record, "utf8") : undefined;

		const refused = importMovedSession({
			bundleDir,
			targetCwd: cwdB,
			ledger,
			readIdentity,
			probeNameFolding: async () => APART,
		});

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(existsSync(record) ? readFileSync(record, "utf8") : undefined).toBe(before);
		expect(existsSync(join(getDefaultSessionDir(cwdB), ".move-staging"))).toBe(false);
	});

	it("#given a sidecar listed under the staging's payload folder, and a payload of the same path #then the import is refused as an invalid bundle before the move's record is touched", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await bundleWithPayloadTwin();
		const record = join(ledger.dir, `${MOVE}.json`);
		const before = existsSync(record) ? readFileSync(record, "utf8") : undefined;

		const refused = importMovedSession({
			bundleDir,
			targetCwd: cwdB,
			ledger,
			readIdentity,
			probeNameFolding: async () => APART,
		});

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(existsSync(record) ? readFileSync(record, "utf8") : undefined).toBe(before);
	});

	it("#given a manifest #then its staged names are the session's own file name, each sidecar without its prefix, and each payload file under the staging's payload folder", async () => {
		const { bundleDir } = await bundleWithSidecar(() => "notes.txt");
		const manifest = parseManifest(readFileSync(join(bundleDir, "manifest.json"), "utf8"));

		const names = stagedNames(manifest);

		expect(names).toContain(manifest.sessionFileName);
		expect(names).toContain("notes.txt");
		expect(names).not.toContain("files/notes.txt");
		for (const file of manifest.payloads.flatMap((payload) => payload.files))
			expect(names).toContain(`${STAGED_PAYLOADS}/${file.path}`);
	});
});

describe("the probe's own file (senpi#6523's review)", () => {
	const old = (file: string) =>
		utimesSync(file, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));

	it("#given a probe file an earlier probe left behind more than an hour ago #when the folder is probed again #then it is removed, #and a younger one and a file of another name are kept", async () => {
		const folder = mkdtempSync(join(tmpdir(), "senpi-probe-sweep-"));
		const stale = join(folder, ".name-probe-0123456789ab-A\u00e9");
		const young = join(folder, ".name-probe-ba9876543210-A\u00e9");
		const other = join(folder, ".name-probe-notes");
		for (const file of [stale, young, other]) writeFileSync(file, "");
		old(stale);
		old(other);

		await probeNameFolding(folder);

		expect(readdirSync(folder).sort()).toEqual([".name-probe-ba9876543210-A\u00e9", ".name-probe-notes"].sort());
	});
	it("#given a stale probe entry this process cannot remove #when the folder is probed #then the probe still answers: an entry it fails to sweep does not fail the import", async () => {
		const folder = mkdtempSync(join(tmpdir(), "senpi-probe-sweep-"));
		const stuck = join(folder, ".name-probe-0123456789ab-A\u00e9");
		mkdirSync(join(stuck, "inside"), { recursive: true });
		old(stuck);

		await expect(probeNameFolding(folder)).resolves.toEqual({
			letterCase: expect.any(Boolean),
			unicodeForm: expect.any(Boolean),
		});
		expect(existsSync(stuck)).toBe(true);
	});
});
