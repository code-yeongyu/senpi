import { lstatSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathWithoutOpenStrict } from "../../../../utils/paths.ts";
import { isCredentialPath } from "./auto-credentials.ts";

/** Hidden project entries `auto` may touch: repository metadata and formatter/linter configs. */
const SAFE_HIDDEN_NAMES = new Set([
	".github",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".nvmrc",
	".node-version",
	".prettierrc",
	".prettierignore",
	".eslintrc",
	".eslintignore",
	".stylelintrc",
	".markdownlint.json",
]);

export type TargetKind = "file" | "directory" | "missing" | "other";

const physicalPath = (target: string): string | undefined => {
	try {
		const resolved = realpathWithoutOpenStrict(target);
		return resolved.split(path.sep).includes("..") ? undefined : resolved;
	} catch {
		return undefined;
	}
};

/**
 * The project root `auto` works in, or undefined when the session root is `/`, the home directory, any
 * ancestor of it (`/Users`, `/home`), or inside a hidden directory (`~/.config`): from there login
 * items, app stores and tool configs would count as project files.
 */
function projectRoot(cwd: string): string | undefined {
	const root = physicalPath(path.resolve(cwd));
	const home = physicalPath(os.homedir());
	if (root === undefined || home === undefined) return undefined;
	const homeFromRoot = path.relative(root, home);
	const rootContainsHome = homeFromRoot === "" || (!homeFromRoot.startsWith("..") && !path.isAbsolute(homeFromRoot));
	const hiddenRoot = root.split(path.sep).some((segment) => segment.startsWith("."));
	return root === path.parse(root).root || rootContainsHome || hiddenRoot ? undefined : root;
}

/** Whether something, even a dangling symlink, exists at `target` itself; git looks at the name. */
export function existsAtName(target: string): boolean {
	try {
		return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
	} catch {
		// A name the filesystem refuses (too long, a loop, no permission) is not a plain ref either:
		// report it as existing so the caller checks it as a path, and that check asks.
		return true;
	}
}

/** Whether `cwd` is a root `auto` approves anything in (see `projectRoot`). */
export function isProjectSession(cwd: string): boolean {
	return projectRoot(cwd) !== undefined;
}

/** What is at `target` after following every symlink, without opening anything. */
export function targetKind(target: string): TargetKind {
	const physical = physicalPath(target);
	if (physical === undefined) return "other";
	try {
		const stats = lstatSync(physical);
		return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
	}
}

/**
 * Whether `auto` may touch the absolute path `target` that a tool resolved: after following every
 * symlink it is inside the project root, no component below the root is hidden (other than a
 * short list of repository and formatter files), and nothing along it is credential-shaped.
 */
export function isApprovableTarget(target: string, cwd: string): boolean {
	const root = projectRoot(cwd);
	const physical = physicalPath(target);
	if (root === undefined || physical === undefined) return false;
	const below = path.relative(root, physical);
	if (below === "") return true;
	if (below.startsWith("..") || path.isAbsolute(below)) return false;
	if (below.split(path.sep).some((segment) => segment.startsWith(".") && !SAFE_HIDDEN_NAMES.has(segment))) {
		return false;
	}
	return !isCredentialPath(physical) && !isCredentialPath(target);
}
