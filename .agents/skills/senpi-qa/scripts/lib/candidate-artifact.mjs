// Candidate engine injection (brain/hand plan S21a, part 1 of 2; acceptance R10.d.a).
//
// S21a's flip of the default execution pipeline is judged on more surfaces than senpi's own EQ: the omo plugin's EQ
// (EQ.omo, `packages/omo-senpi/scripts/qa/fused-equivalence-e2e.mjs --engine <senpi tarball>`) and the desktop app's
// EQ (EQ.desktop, `scripts/qa/fused-equivalence-desktop.ts --engine <engine bundle tarball>`). Both drivers already
// take a candidate through `--engine`; this module binds them to ONE senpi candidate before any run starts:
//
//   - the senpi tarball must be a packed `@code-yeongyu/senpi` with its `bin.senpi` CLI inside (what EQ.omo unpacks);
//   - the desktop bundle must be for this platform, carry its `omo` binary, and have been built from the candidate's
//     senpi commit (its `bundle-manifest.json` `senpiRef`), or EQ.desktop would judge some other engine;
//   - the receipt fields (plan §2.4: `engine.senpi` = the tarball's sha256, `sources.senpi`, `artifacts`) and the two
//     drivers' argv/cwd come from the same inspected bytes.
//
// Nothing runs a driver here: callers get the commands and run them. No default path imports this module.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SENPI_PACKAGE = "@code-yeongyu/senpi";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tarEntries(path) {
	const list = spawnSync("tar", ["-tzf", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (list.status !== 0) throw new Error(`could not list ${path} as a gzip tarball: ${list.stderr.trim()}`);
	return new Set(
		list.stdout
			.split("\n")
			.filter((entry) => entry !== "")
			.map((entry) => entry.replace(/^\.\//, "")),
	);
}

function tarJson(path, entry) {
	const read = spawnSync("tar", ["-xzOf", path, entry], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (read.status !== 0) throw new Error(`could not read ${entry} from ${path}: ${read.stderr.trim()}`);
	try {
		return JSON.parse(read.stdout);
	} catch (error) {
		throw new Error(`${entry} in ${path} is not JSON: ${error.message}`);
	}
}

/**
 * A packed senpi candidate (`npm pack` of packages/coding-agent): its identity, its CLI and the sha256 of its bytes.
 * @param {string} tarballPath
 * @returns {{ path: string, sha256: string, name: string, version: string, cli: string }}
 */
export function inspectSenpiTarball(tarballPath) {
	const path = resolve(tarballPath);
	const entries = tarEntries(path);
	if (!entries.has("package/package.json")) throw new Error(`${path} has no package/package.json`);
	const manifest = tarJson(path, "package/package.json");
	if (manifest.name !== SENPI_PACKAGE) throw new Error(`${path} is ${manifest.name}, not ${SENPI_PACKAGE}`);
	if (typeof manifest.version !== "string") throw new Error(`${path} has no package version`);
	const cli = typeof manifest.bin?.senpi === "string" ? manifest.bin.senpi.replace(/^\.\//, "") : undefined;
	if (cli === undefined || !entries.has(`package/${cli}`))
		throw new Error(`${path} has no senpi CLI package/${cli ?? "<bin.senpi>"}`);
	return { path, sha256: sha256File(path), name: manifest.name, version: manifest.version, cli };
}

/**
 * A desktop engine bundle tarball (`tar -czf engine.tgz -C omo-runtime <platform>`, or packed at its root), checked
 * the way EQ.desktop's candidate loader reads it.
 * @param {string} tarballPath
 * @param {string} platform the golden platform of this run, e.g. `darwin-arm64`
 * @returns {{ path: string, sha256: string, senpiRef: string, omoRef: string, platform: string }}
 */
export function inspectDesktopBundle(tarballPath, platform) {
	const path = resolve(tarballPath);
	const entries = tarEntries(path);
	const dir = entries.has(`${platform}/bundle-manifest.json`) ? `${platform}/` : "";
	if (!entries.has(`${dir}bundle-manifest.json`)) throw new Error(`${path} has no bundle-manifest.json`);
	const manifest = tarJson(path, `${dir}bundle-manifest.json`);
	for (const field of ["senpiRef", "omoRef", "platform"])
		if (typeof manifest[field] !== "string") throw new Error(`${path} bundle-manifest.json lacks ${field}`);
	if (manifest.platform !== platform)
		throw new Error(`engine bundle ${path} is for ${manifest.platform}, this run is ${platform}`);
	if (!entries.has(`${dir}omo`)) throw new Error(`engine bundle ${path} has no omo binary`);
	return { path, sha256: sha256File(path), senpiRef: manifest.senpiRef, omoRef: manifest.omoRef, platform };
}

/**
 * The receipt fields and the EQ.omo / EQ.desktop invocations for one senpi candidate. Throws before any run when the
 * two artifacts do not describe the same candidate.
 * @param {{ senpiTarball: string, senpiRef: string, desktopBundle: string, platform: string,
 *   senpiRepo: string, omoRepo: string, desktopRepo: string }} input
 */
export function candidateInjection(input) {
	if (!COMMIT_SHA.test(input.senpiRef))
		throw new Error(`senpiRef must be the candidate's full 40-hex commit sha, got ${JSON.stringify(input.senpiRef)}`);
	const senpi = inspectSenpiTarball(input.senpiTarball);
	const bundle = inspectDesktopBundle(input.desktopBundle, input.platform);
	if (bundle.senpiRef !== input.senpiRef)
		throw new Error(
			`engine bundle ${bundle.path} was built from senpi ${bundle.senpiRef}, not the candidate ${input.senpiRef}`,
		);
	return {
		engine: { senpi: senpi.sha256 },
		sources: { senpi: { version: senpi.version, sha: input.senpiRef } },
		artifacts: [
			{ path: senpi.path, sha256: senpi.sha256 },
			{ path: bundle.path, sha256: bundle.sha256 },
		],
		commands: [
			{
				manifest_id: "EQ.omo",
				cwd: input.omoRepo,
				argv: [
					"node",
					"packages/omo-senpi/scripts/qa/fused-equivalence-e2e.mjs",
					"--compare",
					"--engine",
					senpi.path,
					"--senpi-repo",
					input.senpiRepo,
				],
			},
			{
				manifest_id: "EQ.desktop",
				cwd: input.desktopRepo,
				argv: [
					"node",
					"scripts/qa/fused-equivalence-desktop.ts",
					"--compare",
					"--engine",
					bundle.path,
					"--senpi",
					input.senpiRepo,
				],
			},
		],
	};
}
