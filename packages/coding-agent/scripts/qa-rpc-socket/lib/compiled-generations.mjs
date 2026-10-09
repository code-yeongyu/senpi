/**
 * Two REAL compiled binaries of THIS tree, differing only in the build identity compiled into
 * them.
 *
 * A generation handoff is decided on `engineOrdinal`, whose last component is the build epoch
 * `bun build --define SENPI_BUILD_EPOCH=...` writes into the binary (see
 * `src/core/engine-build-identity.ts` and `scripts/build-binaries.sh`). Two binaries built from
 * one working tree therefore differ exactly where the decision reads - which is what makes the
 * upgrade path testable without shipping a release in between.
 *
 * The `package.json` and `theme/` beside each binary are not decoration: a bun standalone resolves
 * its own VERSION and its install root from the manifest next to it
 * (`--compile-autoload-package-json`). Without the manifest every generation reports `0.0.0` and
 * the ordinal loses its CalVer half; with the manifest but without the themes, the binary resolves
 * its assets beside itself and dies on a missing `theme/dark.json` (this is what
 * `npm run copy-binary-assets` stages for a release).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** One day, so the two generations are ordered by epoch exactly as two daily releases would be. */
const EPOCH_STRIDE_SECONDS = 86_400;

const COMPILE_FLAGS = [
	"--compile",
	"--splitting",
	"--compile-autoload-package-json",
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-bunfig",
	"--minify",
	"--keep-names",
];

const ENTRYPOINTS = ["./dist/bun/cli.js", "./src/modes/rpc/session-worker.ts", "./src/utils/image-resize-worker.ts"];

/**
 * Answers the older and newer generation to drive the matrix with: the two paths a caller named,
 * or two binaries compiled here from `packageDir`'s build output.
 */
export function resolveGenerations(packageDir, outDir, prebuilt) {
	if (prebuilt.older !== undefined && prebuilt.newer !== undefined) {
		return { built: false, older: { path: resolve(prebuilt.older) }, newer: { path: resolve(prebuilt.newer) } };
	}
	buildPackage(packageDir);
	const head = headIdentity(packageDir);
	return {
		built: true,
		older: compileGeneration(packageDir, join(outDir, "gen-older"), head),
		newer: compileGeneration(packageDir, join(outDir, "gen-newer"), {
			epoch: head.epoch + EPOCH_STRIDE_SECONDS,
			sha7: rotate(head.sha7),
		}),
	};
}

/** Compiles one generation and answers where it landed and what identity it carries. */
function compileGeneration(packageDir, directory, identity) {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "pi");
	execFileSync(
		"bun",
		[
			"build",
			...COMPILE_FLAGS,
			"--define",
			`SENPI_BUILD_EPOCH=${identity.epoch}`,
			"--define",
			`SENPI_BUILD_SHA7="${identity.sha7}"`,
			...ENTRYPOINTS,
			"--outfile",
			path,
		],
		{ cwd: packageDir, stdio: ["ignore", 2, 2] },
	);
	stageBinaryAssets(packageDir, directory);
	signAdHoc(path);
	return { path, ...identity };
}

/** The manifest and themes a standalone resolves beside itself, as `copy-binary-assets` stages them. */
function stageBinaryAssets(packageDir, directory) {
	copyFileSync(join(packageDir, "package.json"), join(directory, "package.json"));
	const themeSource = join(packageDir, "src", "modes", "interactive", "theme");
	const themeTarget = join(directory, "theme");
	mkdirSync(themeTarget, { recursive: true });
	for (const entry of readdirSync(themeSource).filter((name) => name.endsWith(".json"))) {
		copyFileSync(join(themeSource, entry), join(themeTarget, entry));
	}
}

/** The bundle both generations are compiled from; building it is minutes, compiling one is seconds. */
function buildPackage(packageDir) {
	if (existsSync(join(packageDir, "dist", "bun", "cli.js"))) return;
	execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: ["ignore", 2, 2] });
	execFileSync("node", [join(packageDir, "..", "..", "scripts", "prepare-bun-compile-assets.mjs")], {
		cwd: packageDir,
		stdio: ["ignore", 2, 2],
	});
}

/** The committer identity of HEAD, or a synthetic one when the tree carries no git metadata. */
function headIdentity(packageDir) {
	try {
		const epoch = execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: packageDir, encoding: "utf8" }).trim();
		const sha7 = execFileSync("git", ["log", "-1", "--format=%h", "--abbrev=7"], {
			cwd: packageDir,
			encoding: "utf8",
		}).trim();
		return { epoch: Number(epoch), sha7 };
	} catch {
		return { epoch: Math.floor(Date.now() / 1000), sha7: "0000000" };
	}
}

/** A distinct sha for the successor: the two binaries are the same code with two identities. */
function rotate(sha7) {
	const last = sha7.slice(-1);
	return `${sha7.slice(0, -1)}${last === "f" ? "e" : "f"}`;
}

/** darwin refuses to exec a binary whose signature no longer matches; `build-binaries.sh` re-signs too. */
function signAdHoc(path) {
	if (process.platform !== "darwin") return;
	try {
		execFileSync("codesign", ["--remove-signature", path], { stdio: "ignore" });
	} catch {}
	execFileSync("codesign", ["--force", "--sign", "-", path], { stdio: ["ignore", 2, 2] });
}
