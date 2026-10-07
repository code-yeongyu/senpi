import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

/**
 * Refuses a staged revision that links to code outside itself: a PEP 660 editable install
 * (`direct_url.json` with `dir_info.editable`), a legacy `setup.py develop` (`.egg-link`), a `.pth` path
 * line that resolves outside the revision, or a symlink anywhere in it that does. `.pth` lines starting
 * with `import` are code that runs at startup, like any installed package's code, and are not inspected.
 * A refused revision is never published.
 */
export async function assertNoEditableInstalls(staging: string): Promise<void> {
	const root = await realpath(staging).catch(() => resolve(staging));
	let entries: string[];
	try {
		entries = await readdir(staging);
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(staging, entry);
		if (entry.endsWith(".egg-link"))
			refuse(entry.replace(/\.egg-link$/u, ""), "a legacy editable install (.egg-link)");
		if (
			entry.endsWith(".dist-info") &&
			isEditable(await readFile(join(path, "direct_url.json"), "utf8").catch(() => ""))
		) {
			refuse(entry.replace(/\.dist-info$/u, ""), "an editable install");
		}
		if (entry.endsWith(".pth")) {
			for (const line of (await readFile(path, "utf8").catch(() => "")).split(/\r?\n/u)) {
				const text = line.trim();
				if (text === "" || text.startsWith("#") || text.startsWith("import ")) continue;
				if (!(await inside(root, resolve(staging, text))))
					refuse(entry, `a path outside the environment (${text})`);
			}
		}
	}
	await refuseOutsideLinks(root, staging);
}

/** Every symlink in the revision, at any depth, must resolve inside it; links are checked, not followed. */
async function refuseOutsideLinks(root: string, dir: string): Promise<void> {
	for (const entry of await readdir(dir)) {
		const path = join(dir, entry);
		const info = await lstat(path);
		if (info.isSymbolicLink()) {
			if (!(await inside(root, path))) refuse(relative(root, path), "a link that points outside the environment");
		} else if (info.isDirectory()) {
			await refuseOutsideLinks(root, path);
		}
	}
}

/**
 * pip reports what it installed; each of those distributions must be in the revision. A configuration
 * that redirects pip elsewhere (a target, root or prefix from any config file or variable, on any pip
 * version) leaves them missing here, so the install fails instead of publishing an empty revision.
 */
export async function assertInstalledInRevision(stdout: string, staging: string): Promise<void> {
	const line = stdout.split("\n").find((entry) => entry.startsWith("Successfully installed "));
	if (line === undefined) return;
	const present = new Set((await readdir(staging).catch(() => [] as string[])).flatMap(installedName));
	for (const token of line.slice("Successfully installed ".length).trim().split(/\s+/u)) {
		const name = token.slice(0, token.lastIndexOf("-"));
		if (!present.has(canonicalName(name))) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${name} was installed outside the session's environment (pip's configuration redirected it); nothing was published`,
			);
		}
	}
}

/**
 * The project a metadata entry records: `name-version.dist-info` (wheels), or `name-version[-pyX.Y].egg-info`
 * (a setup.py project pip <= 23.0 installs without the wheel package). Both escape `-` in the name to `_`.
 */
function installedName(entry: string): string[] {
	if (entry.endsWith(".dist-info")) {
		const stem = entry.slice(0, -".dist-info".length);
		return [canonicalName(stem.slice(0, stem.lastIndexOf("-")))];
	}
	if (entry.endsWith(".egg-info")) return [canonicalName(entry.split("-")[0] ?? "")];
	return [];
}

function canonicalName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/gu, "_");
}

async function inside(root: string, path: string): Promise<boolean> {
	const real = await realpath(path).catch(() => resolve(path));
	const rel = relative(root, real);
	return (
		rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/u.test(rel))
	);
}

function refuse(name: string, what: string): never {
	throw new EnvironmentError(
		"environment_install_failed",
		`${name} was installed as ${what}; packages must live in the session's environment root, so editable and linked installs are not allowed`,
	);
}

function isEditable(text: string): boolean {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || !("dir_info" in value)) return false;
		const dirInfo = value.dir_info;
		return typeof dirInfo === "object" && dirInfo !== null && "editable" in dirInfo && dirInfo.editable === true;
	} catch {
		return false;
	}
}
