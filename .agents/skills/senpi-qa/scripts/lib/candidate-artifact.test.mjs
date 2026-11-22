import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { candidateInjection, inspectDesktopBundle, inspectSenpiTarball } from "./candidate-artifact.mjs";

const scratch = mkdtempSync(join(tmpdir(), "candidate-artifact-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SENPI_REF = "e005a4e122dee737960a7bdc566afacb7d54b2c3";
let serial = 0;

/**
 * Write `files` (relative path -> contents) under a fresh root and pack it, returning the tarball path. `packing`
 * "paths" names each file (`tar -czf out -C root <path>...`, stored names as written, the way `npm pack` stores
 * `package/...`); "dot" packs the whole root (`tar -czf out -C root .`, every stored name prefixed with `./`).
 */
function tarball(name, files, packing = "paths") {
	const root = join(scratch, `src-${serial++}`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	const out = join(scratch, name);
	const members = packing === "dot" ? ["."] : Object.keys(files);
	const tar = spawnSync("tar", ["-czf", out, "-C", root, ...members], { encoding: "utf8" });
	assert.equal(tar.status, 0, tar.stderr);
	const stored = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	assert.equal(stored.every((entry) => entry.startsWith("./")), packing === "dot", stored.join(", "));
	return out;
}

const senpiPackage = (manifest, extra = {}) =>
	tarball(`senpi-${serial}.tgz`, {
		"package/package.json": JSON.stringify(manifest),
		...extra,
	});

const SENPI_MANIFEST = {
	name: "@code-yeongyu/senpi",
	version: "2026.11.02-1",
	bin: { pi: "dist/bundle/cli.js", senpi: "dist/bundle/cli.js" },
};

const bundleManifest = (overrides = {}) =>
	JSON.stringify({ senpiRef: SENPI_REF, omoRef: "v5.1.57", platform: "darwin-arm64", ...overrides });

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("inspectSenpiTarball", () => {
	test("reads the package identity and hashes the tarball bytes", () => {
		const path = senpiPackage(SENPI_MANIFEST, { "package/dist/bundle/cli.js": "#!/usr/bin/env bun\n" });
		assert.deepEqual(inspectSenpiTarball(path), {
			path,
			sha256: sha256(path),
			name: "@code-yeongyu/senpi",
			version: "2026.11.02-1",
			cli: "dist/bundle/cli.js",
		});
	});

	test("reads a package packed from its root with `-C root .`", () => {
		const path = tarball(
			"senpi-dot.tgz",
			{ "package/package.json": JSON.stringify(SENPI_MANIFEST), "package/dist/bundle/cli.js": "" },
			"dot",
		);
		assert.deepEqual(inspectSenpiTarball(path), {
			path,
			sha256: sha256(path),
			name: "@code-yeongyu/senpi",
			version: "2026.11.02-1",
			cli: "dist/bundle/cli.js",
		});
	});

	test("refuses a package whose senpi CLI is not in the archive", () => {
		const path = senpiPackage(SENPI_MANIFEST, { "package/dist/index.js": "" });
		assert.throws(() => inspectSenpiTarball(path), /no senpi CLI package\/dist\/bundle\/cli\.js/);
	});

	test("refuses a tarball of some other package", () => {
		const path = senpiPackage({ ...SENPI_MANIFEST, name: "@earendil-works/pi-agent-core" }, {
			"package/dist/bundle/cli.js": "",
		});
		assert.throws(() => inspectSenpiTarball(path), /is @earendil-works\/pi-agent-core, not @code-yeongyu\/senpi/);
	});

	test("refuses a file that is not a gzip tarball", () => {
		const path = join(scratch, "not-a-tarball.tgz");
		writeFileSync(path, "plain text");
		assert.throws(() => inspectSenpiTarball(path), /could not list/);
	});
});

describe("inspectDesktopBundle", () => {
	test("reads a bundle packed under its platform directory", () => {
		const path = tarball("bundle-nested.tgz", {
			"darwin-arm64/bundle-manifest.json": bundleManifest(),
			"darwin-arm64/omo": "binary",
		});
		assert.deepEqual(inspectDesktopBundle(path, "darwin-arm64"), {
			path,
			sha256: sha256(path),
			senpiRef: SENPI_REF,
			omoRef: "v5.1.57",
			platform: "darwin-arm64",
		});
	});

	test("reads a bundle packed at the archive root", () => {
		const path = tarball("bundle-root.tgz", { "bundle-manifest.json": bundleManifest(), omo: "binary" });
		assert.equal(inspectDesktopBundle(path, "darwin-arm64").senpiRef, SENPI_REF);
	});

	for (const [layout, files] of [
		["under its platform directory", { "darwin-arm64/bundle-manifest.json": bundleManifest(), "darwin-arm64/omo": "" }],
		["at the archive root", { "bundle-manifest.json": bundleManifest(), omo: "" }],
	])
		test(`reads a bundle packed ${layout} with \`-C root .\``, () => {
			const path = tarball(`bundle-dot-${serial}.tgz`, files, "dot");
			assert.equal(inspectDesktopBundle(path, "darwin-arm64").senpiRef, SENPI_REF);
		});

	test("reads the platform directory whenever the archive has one, as EQ.desktop's loader does", () => {
		const path = tarball("bundle-split.tgz", {
			"bundle-manifest.json": bundleManifest(),
			omo: "binary",
			"darwin-arm64/omo": "binary",
		});
		assert.throws(() => inspectDesktopBundle(path, "darwin-arm64"), /has no darwin-arm64\/bundle-manifest\.json/);
	});

	test("refuses a bundle built for another platform", () => {
		const path = tarball("bundle-linux.tgz", {
			"bundle-manifest.json": bundleManifest({ platform: "linux-x64" }),
			omo: "binary",
		});
		assert.throws(() => inspectDesktopBundle(path, "darwin-arm64"), /is for linux-x64, this run is darwin-arm64/);
	});

	test("refuses a bundle with no omo binary beside its manifest", () => {
		const path = tarball("bundle-no-binary.tgz", { "bundle-manifest.json": bundleManifest() });
		assert.throws(() => inspectDesktopBundle(path, "darwin-arm64"), /has no omo binary/);
	});
});

describe("candidateInjection", () => {
	const senpiTarball = senpiPackage(SENPI_MANIFEST, { "package/dist/bundle/cli.js": "" });
	const desktopBundle = tarball("bundle-candidate.tgz", {
		"darwin-arm64/bundle-manifest.json": bundleManifest(),
		"darwin-arm64/omo": "binary",
	});
	const input = {
		senpiTarball,
		senpiRef: SENPI_REF,
		desktopBundle,
		platform: "darwin-arm64",
		senpiRepo: "/work/senpi",
		omoRepo: "/work/omo",
		desktopRepo: "/work/desktop",
	};

	test("binds both EQ surfaces and the receipt to the same senpi candidate", () => {
		assert.deepEqual(candidateInjection(input), {
			engine: { senpi: sha256(senpiTarball) },
			sources: { senpi: { version: "2026.11.02-1", sha: SENPI_REF } },
			artifacts: [
				{ path: senpiTarball, sha256: sha256(senpiTarball) },
				{ path: desktopBundle, sha256: sha256(desktopBundle) },
			],
			commands: [
				{
					manifest_id: "EQ.omo",
					cwd: "/work/omo",
					argv: [
						"node",
						"packages/omo-senpi/scripts/qa/fused-equivalence-e2e.mjs",
						"--compare",
						"--engine",
						senpiTarball,
						"--senpi-repo",
						"/work/senpi",
					],
				},
				{
					manifest_id: "EQ.desktop",
					cwd: "/work/desktop",
					argv: [
						"node",
						"scripts/qa/fused-equivalence-desktop.ts",
						"--compare",
						"--engine",
						desktopBundle,
						"--senpi",
						"/work/senpi",
					],
				},
			],
		});
	});

	test("refuses a desktop bundle built from another senpi commit", () => {
		const stale = tarball("bundle-stale.tgz", {
			"bundle-manifest.json": bundleManifest({ senpiRef: "0".repeat(40) }),
			omo: "binary",
		});
		assert.throws(
			() => candidateInjection({ ...input, desktopBundle: stale }),
			/built from senpi 0{40}, not the candidate e005a4e1/,
		);
	});

	test("refuses a candidate commit that is not a full sha", () => {
		assert.throws(() => candidateInjection({ ...input, senpiRef: "v2026.11.02-1" }), /full 40-hex commit sha/);
	});
});
