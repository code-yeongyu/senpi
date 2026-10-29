// Turn a finished case run into its normalized observation set, and build the baseline manifest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createNormalizer, directoryRoots } from "../../../../scripts/lib/equivalence-normalize.mjs";
import { collectors } from "./collectors.mjs";
import { childRuntimeFacts, goldenPlatform, hostFacts } from "./host.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EQ_DIR = join(SKILL, "scenarios", "fused-equivalence");

/** Normalize every observable the case declares, with one token map per observable. */
export function observe(run, observables) {
	const normalize = createNormalizer({
		roots: [
			// The sandbox as allocated and as resolved (the child reports its resolved cwd; macOS temp dirs are symlinked), each
			// also as a session-directory key (a host files sessions under `--<cwd with / as ->--`).
			...directoryRoots(run.box.dir, "<sandbox>", { keyed: "<sandbox-key>" }),
			...directoryRoots(run.repo, "<repo>"),
			{ prefix: run.server.origin, token: "<model-server>" },
			{ prefix: run.server.origin.replace(/^http:\/\//, ""), token: "<model-server-host>" },
			...run.extraRoots,
		],
		hostFacts: [...hostFacts(), ...childRuntimeFacts(run.childRuntime)],
	});
	return Object.fromEntries(observables.map((id) => [id, normalize(collectors[id](run))]));
}

function hashTree(root) {
	const hash = createHash("sha256");
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name !== "golden") walk(full);
				continue;
			}
			hash.update(relative(root, full).split(sep).join("/")).update("\0").update(readFileSync(full)).update("\0");
		}
	};
	walk(root);
	return `sha256:${hash.digest("hex")}`;
}

const hashFile = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

function git(args, cwd) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** The baseline manifest (plan §6.2): repo SHA, runtimes, and the harness, fixture and normalizer hashes. */
export function baselineManifest({ repo, childRuntime, command }) {
	return {
		// A checkout exported without its .git (a recording container) names its commit through EQ_SOURCE_COMMIT.
		repo: {
			head: git(["rev-parse", "HEAD"], repo) ?? process.env.EQ_SOURCE_COMMIT ?? null,
			dirty: (git(["status", "--porcelain"], repo) ?? "") !== "",
		},
		platform: goldenPlatform(),
		runtimes: { harness: `node@${process.versions.node}`, child: childRuntime },
		hashes: {
			harness: hashFile(join(SKILL, "scripts", "scenarios", "fused-equivalence-qa.mjs")),
			normalizer: hashFile(join(SKILL, "scripts", "lib", "equivalence-normalize.mjs")),
			fakeModelServer: hashFile(join(SKILL, "scripts", "lib", "fake-model-server.mjs")),
			cases: hashTree(join(EQ_DIR, "cases")),
			fixtures: hashTree(join(EQ_DIR, "fixtures")),
		},
		command,
	};
}

export const goldenDir = () => join(EQ_DIR, "golden", goldenPlatform());
