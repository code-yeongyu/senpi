// BETA(omo-local-update): removable beta module - delete together with
// omo-local-update.ts and all test/omo-local-update* files.
//
// Build-input fingerprint of origin/dev: a sha256 over the repo's ROOT tree
// entries (from `git ls-tree -z origin/dev`), excluding top-level paths that
// can never feed `bun install` + `bun run build:senpi-plugin`. The exclusion
// direction is the safety property: an entry wrongly INCLUDED only causes an
// unnecessary rebuild, while an entry wrongly EXCLUDED would ship a stale
// plugin - so only clearly build-irrelevant documentation/agent-config paths
// are listed, and every unknown root path counts as a build input.

import { createHash } from "node:crypto";

const EXCLUDED_ROOT_PATHS: ReadonlySet<string> = new Set([
	".agents",
	".claude",
	".codex",
	".cursor",
	".devcontainer",
	".env.example",
	".gitattributes",
	".github",
	".idea",
	".mcp.json",
	".omo",
	".opencode",
	".vscode",
	"AGENTS.md",
	"CHANGELOG.md",
	"CLA.md",
	"CLAUDE.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"LICENSE.md",
	"ROADMAP.md",
	"THIRD-PARTY-NOTICES.md",
	"assets",
	"docs",
]);

/** exported for tests only */
export function isBuildInputRootPath(name: string): boolean {
	return !EXCLUDED_ROOT_PATHS.has(name) && !name.startsWith("README");
}

/** Digest NUL-separated `git ls-tree -z` root entries into the build-input fingerprint. */
export function computeBuildInputsHashFromLsTree(lsTreeOutput: string): string {
	const hash = createHash("sha256");
	for (const entry of lsTreeOutput.split("\0")) {
		const tabIndex = entry.indexOf("\t");
		if (tabIndex === -1) {
			continue;
		}
		const name = entry.slice(tabIndex + 1);
		if (!isBuildInputRootPath(name)) {
			continue;
		}
		const objectHash = entry.slice(0, tabIndex).split(" ")[2] ?? "";
		hash.update(`${objectHash}\t${name}\n`);
	}
	return hash.digest("hex");
}
