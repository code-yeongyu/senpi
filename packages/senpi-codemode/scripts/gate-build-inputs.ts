import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { glob, lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GateInputError } from "./gate-input-error.ts";
import { runProcess } from "./gate-process.ts";

const manifestSchema = Type.Object({ main: Type.Optional(Type.String()) });
const configSchema = Type.Object({
	extends: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
});
export const fingerprintSchema = Type.Record(Type.String(), Type.String());
type BuildSnapshot = Readonly<Record<string, Readonly<Record<string, string>>>>;

export async function builtWorkspaces(target: string) {
	const root = await realpath(resolve(target, "../.."));
	const workspaces: { readonly directory: string; readonly label: string; readonly entry: string }[] = [];
	for await (const path of glob("packages/*/package.json", { cwd: root })) {
		const manifest: unknown = JSON.parse(await readFile(resolve(root, path), "utf8"));
		if (!Check(manifestSchema, manifest)) throw new GateInputError(path);
		if (!manifest.main?.replace(/^\.\//u, "").startsWith("dist/")) continue;
		const directory = resolve(root, path, "..");
		workspaces.push({
			directory, label: relative(root, directory).replaceAll("\\", "/"),
			entry: resolve(directory, manifest.main),
		});
	}
	return workspaces;
}

export async function buildFingerprint(workspace: string): Promise<Record<string, string>> {
	const names = ["package.json", ...(await readdir(workspace)).filter((name) => /^tsconfig.*\.json$/u.test(name))];
	const configs = names.filter((name) => /^tsconfig.*\.json$/u.test(name));
	for (const name of configs) {
		const path = resolve(workspace, name);
		const parsed = await runProcess([
			"bun", "-e",
			"console.log(JSON.stringify(Bun.JSONC.parse(await Bun.file(process.argv[1]).text())))",
			path,
		], workspace);
		if (parsed.exitCode !== 0)
			throw new GateInputError(`build configuration: ${name}: ${parsed.stderr}`);
		const config: unknown = JSON.parse(parsed.stdout);
		if (!Check(configSchema, config)) throw new GateInputError(`build configuration: ${name}`);
		const parents = typeof config.extends === "string" ? [config.extends] : config.extends ?? [];
		for (const parent of parents) {
			const inherited = relative(workspace, resolve(dirname(path), parent)).replaceAll("\\", "/");
			if (names.includes(inherited)) continue;
			names.push(inherited);
			configs.push(inherited);
		}
	}
	for (const entry of await readdir(resolve(workspace, "src"), { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) names.push(relative(workspace, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"));
	}
	const files: Record<string, string> = {};
	for (const name of names.sort()) {
		files[name] = createHash("sha256").update(await readFile(resolve(workspace, name))).digest("hex");
	}
	return files;
}

export async function captureTargetBuild(target: string): Promise<BuildSnapshot> {
	const inputs: Record<string, Readonly<Record<string, string>>> = {};
	for (const workspace of await builtWorkspaces(target))
		inputs[workspace.label] = await buildFingerprint(workspace.directory);
	return inputs;
}

/** Certifies only the inputs captured before the successful build began. */
export async function recordTargetBuild(target: string, beforeBuild: BuildSnapshot): Promise<void> {
	const root = await realpath(resolve(target, "../.."));
	const workspaces = await builtWorkspaces(target);
	if (Object.keys(beforeBuild).some((label) => !workspaces.some((workspace) => workspace.label === label)))
		throw new GateInputError("workspaces changed during build");
	for (const workspace of workspaces) {
		const before = beforeBuild[workspace.label];
		const current = await buildFingerprint(workspace.directory);
		if (before === undefined || JSON.stringify(before) !== JSON.stringify(current))
			throw new GateInputError(`workspace inputs changed during build: ${workspace.label}; run the gate build again`);
	}
	for (const workspace of workspaces) {
		await assertUnlinkedPath(root, workspace.directory);
		await assertUnlinkedPath(workspace.directory, workspace.entry);
		const sidecar = resolve(workspace.directory, ".senpi-gate-inputs.json");
		await assertUnlinkedPath(workspace.directory, sidecar);
		await readFile(workspace.entry).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new GateInputError(`stale workspace dist: ${workspace.label} (missing build entry; run the gate build)`);
			throw error;
		});
		const certificate = `${JSON.stringify(beforeBuild[workspace.label], null, 2)}\n`;
		const output = await open(sidecar, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
		try {
			await output.writeFile(certificate);
		} finally {
			await output.close();
		}
	}
}

async function assertUnlinkedPath(root: string, path: string): Promise<void> {
	const name = relative(root, path);
	const parts = name.split(sep);
	if (isAbsolute(name) || parts.includes("..")) throw new GateInputError(`build path outside workspace: ${name}`);
	let cursor = root;
	for (const [index, part] of parts.entries()) {
		cursor = resolve(cursor, part);
		try {
			if ((await lstat(cursor)).isSymbolicLink()) throw new GateInputError(`symlinked build path: ${name}`);
		} catch (error) {
			if (index === parts.length - 1 && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
}
