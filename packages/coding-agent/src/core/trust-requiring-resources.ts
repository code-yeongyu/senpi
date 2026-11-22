import { existsSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { bundledBuiltinExtensions } from "./bundled-resources.ts";

/**
 * Which folders hold project resources that ask for a trust decision. Each walk is written once as a generator that
 * yields the filesystem questions it needs answered; `answerSync` serves the terminal's synchronous callers and
 * `answerAsync` the RPC session path, which must not block the shared host (senpi#6185). One walk, two drivers, so
 * the trust check an RPC client sees cannot drift from the one the terminal runs.
 */
type Probe = { readonly kind: "exists"; readonly path: string } | { readonly kind: "read"; readonly path: string };
/** `exists` answers a boolean; `read` answers the UTF-8 text, or undefined when the file cannot be read. */
type Answer = boolean | string | undefined;
type Walk<T> = Generator<Probe, T, Answer>;

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

const LEGACY_PROJECT_CONFIG_DIR_NAME = ".pi";

function* exists(path: string): Walk<boolean> {
	return (yield { kind: "exists", path }) === true;
}

function* readText(path: string): Walk<string | undefined> {
	const text = yield { kind: "read", path };
	return typeof text === "string" ? text : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(stripBom(text)) };
	} catch {
		return { ok: false };
	}
}

function valueAtPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

function* codemodeExecutableSettings(): Walk<readonly string[] | undefined> {
	const codemode = bundledBuiltinExtensions.find((extension) => extension.id === "codemode");
	let packageJson: string | undefined;
	try {
		packageJson = codemode?.resolvePackage();
	} catch {
		return undefined;
	}
	if (packageJson === undefined) return undefined;
	const text = yield* readText(join(dirname(packageJson), "src", "config", "executable-settings.json"));
	const list = text === undefined ? { ok: false as const } : parseJson(text);
	if (!list.ok || typeof list.value !== "object" || list.value === null) return undefined;
	const paths: unknown = Reflect.get(list.value, "projectExecutableSettings");
	return Array.isArray(paths) && paths.every((entry) => typeof entry === "string") ? paths : undefined;
}

/**
 * A project codemode file that sets any setting naming an executable (the codemode package's
 * `executable-settings.json` list, today `languages.pyInterpreter`) makes the session run that executable at start,
 * so it asks for a trust decision. A file the check cannot read is treated like a project `mcp.json`, whose mere
 * presence asks; so is any file when the list itself cannot be read.
 */
function* projectCodemodeNamesExecutable(configDir: string): Walk<boolean> {
	const path = join(configDir, "codemode.json");
	if (!(yield* exists(path))) return false;
	const executableSettings = yield* codemodeExecutableSettings();
	if (executableSettings === undefined) return true;
	const text = yield* readText(path);
	const parsed = text === undefined ? { ok: false as const } : parseJson(text);
	if (!parsed.ok) return true;
	return executableSettings.some((settingPath) => valueAtPath(parsed.value, settingPath) !== undefined);
}

/** True when `dir` is the user's home or a folder above it: never a project (#2465). */
function isHomeOrAboveDir(dir: string, homeDir: string): boolean {
	return dir === homeDir || homeDir.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The nearest folder at or above `dir` that holds `.git`, as spelled; undefined outside a repository. */
function* findGitRepoRoot(dir: string): Walk<string | undefined> {
	let currentDir = dir;
	while (!(yield* exists(join(currentDir, ".git")))) {
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
	return currentDir;
}

function homeDirectory(): string {
	return canonicalizePath(resolvePath(process.env.HOME || homedir()));
}

function* agentsSkillDirs(cwd: string): Walk<string[]> {
	const homeDir = homeDirectory();
	const startDir = resolvePath(cwd);
	const gitRepoRoot = yield* findGitRepoRoot(startDir);
	const dirs: string[] = [];
	let currentDir = startDir;
	while (!isHomeOrAboveDir(canonicalizePath(currentDir), homeDir)) {
		dirs.push(join(currentDir, ".agents", "skills"));
		if (currentDir === gitRepoRoot) break;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return dirs;
}

function* trustRequiringResources(cwd: string): Walk<boolean> {
	const homeDir = homeDirectory();
	const currentDir = canonicalizePath(resolvePath(cwd));
	if (!isHomeOrAboveDir(currentDir, homeDir)) {
		for (const configDir of [join(currentDir, CONFIG_DIR_NAME), join(currentDir, LEGACY_PROJECT_CONFIG_DIR_NAME)]) {
			for (const entry of TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES) {
				if (yield* exists(join(configDir, entry))) return true;
			}
		}
		if (yield* projectCodemodeNamesExecutable(join(currentDir, CONFIG_DIR_NAME))) return true;
	}
	for (const dir of yield* agentsSkillDirs(cwd)) {
		if (yield* exists(dir)) return true;
	}
	return false;
}

function answerSync(probe: Probe): Answer {
	if (probe.kind === "exists") return existsSync(probe.path);
	try {
		return readFileSync(probe.path, "utf8");
	} catch {
		return undefined;
	}
}

async function answerAsync(probe: Probe): Promise<Answer> {
	if (probe.kind === "exists") {
		return access(probe.path).then(
			() => true,
			() => false,
		);
	}
	return readFile(probe.path, "utf8").catch(() => undefined);
}

function runSync<T>(walk: Walk<T>): T {
	let step = walk.next();
	while (!step.done) step = walk.next(answerSync(step.value));
	return step.value;
}

async function runAsync<T>(walk: Walk<T>): Promise<T> {
	let step = walk.next();
	while (!step.done) step = walk.next(await answerAsync(step.value));
	return step.value;
}

/**
 * The project `.agents/skills` directories for `cwd`, nearest first: one per folder from cwd up to
 * the git root (or the filesystem root), stopping below the user's home. Home and every folder
 * above it are never a project; `~/.agents/skills` is the user's own global skills. The ONE walk
 * both the trust check and the loader use, over the same spelling and the same git root (#3420
 * review): paths stay as spelled (resources are compared as strings), and each folder's real path
 * decides whether it is home or above, so a symlink can't carry the walk past home either way.
 */
export function projectAgentsSkillDirs(cwd: string): string[] {
	return runSync(agentsSkillDirs(cwd));
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under the project config dir or the
 * legacy cwd/.pi dir (whose resources are also discovered), or a project
 * `.agents/skills` (`projectAgentsSkillDirs`, the same walk the loader uses).
 * The user's home and every folder above it are never a project: their config
 * dirs and .agents/skills are the user's own global resources (#2465).
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	return runSync(trustRequiringResources(cwd));
}

/** `hasTrustRequiringProjectResources` without blocking: the same walk, answered through `node:fs/promises`. */
export function hasTrustRequiringProjectResourcesAsync(cwd: string): Promise<boolean> {
	return runAsync(trustRequiringResources(cwd));
}
