import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CodemodeRuntimeAssetEnvironment, resolveCodemodeRuntimeAsset } from "../kernels/shared/runtime-asset.ts";

const BUN_SKILL_BASE_DIR = dirname(fileURLToPath(import.meta.url));

let loggedMissingBunSkill = false;

export const BUN_SKILL_MIN_VERSION = "1.4.0";

/** Reads the js eval kernel's bun version; undefined on a node kernel. */
export type BunKernelVersionSource = () => string | undefined;

const kernelBunVersion: BunKernelVersionSource = () => process.versions.bun;

/**
 * True when the version is at least `BUN_SKILL_MIN_VERSION`: parses the leading
 * `<major>.<minor>` integers of the string and gates on major > 1 || (major === 1 && minor >= 4).
 * Unparseable or missing versions never enable the skill.
 */
export function bunVersionSupportsSkill(version: string | undefined): boolean {
	if (version === undefined) return false;
	const match = /^(\d+)\.(\d+)/.exec(version);
	if (match === null) return false;
	const major = Number.parseInt(match[1]!, 10);
	const minor = Number.parseInt(match[2]!, 10);
	return major > 1 || (major === 1 && minor >= 4);
}

const BUN_SKILL_PACKAGE_RELATIVE_PATH = join("skill", "bun-1-4", "SKILL.md");

/**
 * Absolute path of the bundled bun-1-4 SKILL.md, or undefined (logged once) when it is not shipped.
 *
 * A compiled Bun binary has no readable module-relative asset, so resolution falls back to the
 * codemode sidecar shipped next to the executable, exactly as the Ruby and Julia kernel runners do.
 * The miss is reported on stderr because stdout carries the RPC protocol stream.
 */
export function bundledBunSkillPath(
	baseDir: string = BUN_SKILL_BASE_DIR,
	environment: CodemodeRuntimeAssetEnvironment = {},
): string | undefined {
	const localPath = join(baseDir, "..", "skill", "bun-1-4", "SKILL.md");
	const candidate = resolveCodemodeRuntimeAsset(localPath, BUN_SKILL_PACKAGE_RELATIVE_PATH, environment);
	if (existsSync(candidate)) return candidate;
	if (!loggedMissingBunSkill) {
		loggedMissingBunSkill = true;
		// A compiled binary never has the module-relative asset, so naming only that path
		// would hide the sidecar location an operator actually has to populate.
		const executableDir = dirname(environment.executablePath ?? process.execPath);
		const sidecarPath = join(
			executableDir,
			"node_modules",
			"@code-yeongyu",
			"senpi-codemode",
			"src",
			BUN_SKILL_PACKAGE_RELATIVE_PATH,
		);
		console.error(
			`[senpi-codemode] bundled bun-1-4 skill not found at ${localPath} or ${sidecarPath}; skipping contribution`,
		);
	}
	return undefined;
}

/**
 * Absolute path of the bundled bun-1-4 SKILL.md when it is active for this process:
 * the in-process js eval kernel itself runs bun >= 1.4 (`process.versions.bun`) and the
 * asset is shipped. A node kernel never activates it, regardless of any bun binary on PATH.
 */
export function activeBunSkillPath(
	getKernelBunVersion: BunKernelVersionSource = kernelBunVersion,
	baseDir?: string,
): string | undefined {
	if (!bunVersionSupportsSkill(getKernelBunVersion())) return undefined;
	return bundledBunSkillPath(baseDir);
}

/** Builds the `resources_discover` handler that contributes the active bun-1-4 skill, if any. */
export function createBunSkillDiscoverHandler(
	getKernelBunVersion: BunKernelVersionSource = kernelBunVersion,
	baseDir?: string,
): () => { skillPaths: string[] } | undefined {
	return () => {
		const skillPath = activeBunSkillPath(getKernelBunVersion, baseDir);
		return skillPath === undefined ? undefined : { skillPaths: [skillPath] };
	};
}

export function registerBunSkillContribution(
	pi: {
		on(
			event: "resources_discover",
			handler: (
				event: unknown,
				ctx: unknown,
			) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined,
		): void;
	},
	getKernelBunVersion?: BunKernelVersionSource,
	baseDir?: string,
): void {
	pi.on("resources_discover", createBunSkillDiscoverHandler(getKernelBunVersion, baseDir));
}
