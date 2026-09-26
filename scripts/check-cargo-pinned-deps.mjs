import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The Cargo twin of check-pinned-deps.mjs: every registry dependency in the workspace root and in every member
// crate is an exact `=x.y.z` pin. `workspace = true` and `path` entries resolve inside the repository.
const DEPENDENCY_SECTION = /^\[(?:target\..+\.)?(?:workspace\.)?(?:dev-|build-)?dependencies\]$/;
const ENTRY = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;
const DOTTED_VERSION = /^([A-Za-z0-9_-]+)\.version\s*=\s*(".*)$/;

function entryProblem(value) {
	if (value.startsWith('"')) return value.startsWith('"=') ? undefined : "is not an exact `=` pin";
	if (!value.startsWith("{")) return "has an unrecognized value";
	if (/\bworkspace\s*=\s*true\b/.test(value) || /\bpath\s*=/.test(value)) return undefined;
	const version = /\bversion\s*=\s*"([^"]*)"/.exec(value);
	if (version === null) return "declares no version, workspace, or path on its first line";
	return version[1].startsWith("=") ? undefined : "is not an exact `=` pin";
}

/** Returns one message per unpinned dependency in a Cargo manifest's text. */
export function unpinnedCargoDependencies(manifestText, manifestPath) {
	const problems = [];
	let section;
	for (const rawLine of manifestText.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			section = DEPENDENCY_SECTION.test(line) ? line : undefined;
			continue;
		}
		if (section === undefined || line === "" || line.startsWith("#")) continue;
		const entry = ENTRY.exec(line) ?? DOTTED_VERSION.exec(line);
		if (entry === null) continue;
		const problem = entryProblem(entry[2]);
		if (problem !== undefined) problems.push(`${manifestPath} ${section} ${entry[1]} ${problem}: ${entry[2]}`);
	}
	return problems;
}

function manifestPaths(root) {
	const crates = join(root, "crates");
	const members = readdirSync(crates, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(crates, entry.name, "Cargo.toml"))
		.filter((path) => existsSync(path));
	return [join(root, "Cargo.toml"), ...members];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
	const problems = manifestPaths(root).flatMap((path) =>
		unpinnedCargoDependencies(readFileSync(path, "utf8"), relative(root, path)),
	);
	if (problems.length > 0) {
		console.error("Cargo dependencies must be exact `=` pins:");
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	console.log("All Cargo dependencies are exact pins or workspace/path entries.");
}
