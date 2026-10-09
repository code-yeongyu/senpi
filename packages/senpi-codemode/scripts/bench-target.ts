import { spawn } from "node:child_process";
import { glob, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

export class BenchTargetError extends Error {
	readonly name = "BenchTargetError";
}

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function runProcess(
	command: readonly string[],
	options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
	const [file, ...args] = command;
	if (!file) throw new TypeError("bench command is empty");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
	});
}

export function resolvePackage(path: string): string {
	const requested = resolve(path);
	return requested.endsWith("senpi-codemode") ? requested : resolve(requested, "packages/senpi-codemode");
}

function distMain(manifest: unknown): string | undefined {
	if (typeof manifest !== "object" || manifest === null || !("main" in manifest)) return undefined;
	const main = manifest.main;
	return typeof main === "string" && main.replace(/^\.\//u, "").startsWith("dist/") ? main : undefined;
}

/**
 * The target's own source is what gets compared, but it reaches the other workspace packages through their
 * built `dist`. A build older than any of its inputs would measure a different commit, so it is refused.
 */
export async function assertFreshTarget(target: string): Promise<void> {
	const root = resolve(target, "../..");
	await stat(resolve(root, "node_modules")).catch(() => {
		throw new BenchTargetError(`target has no node_modules: ${root} (run bun install --ignore-scripts)`);
	});
	for await (const manifestPath of glob("packages/*/package.json", { cwd: root })) {
		const main = distMain(JSON.parse(await readFile(resolve(root, manifestPath), "utf8")));
		if (main === undefined) continue;
		const workspace = resolve(root, manifestPath, "..");
		const label = relative(root, workspace).replaceAll("\\", "/");
		const entry = await stat(resolve(workspace, main)).catch(() => {
			throw new BenchTargetError(`stale target ${root}: ${label} has no build (run bun run build)`);
		});
		const inputs = [resolve(root, manifestPath)];
		for (const name of await readdir(workspace))
			if (/^tsconfig.*\.json$/u.test(name)) inputs.push(resolve(workspace, name));
		for (const source of await readdir(resolve(workspace, "src"), { recursive: true, withFileTypes: true })) {
			if (source.isFile()) inputs.push(resolve(source.parentPath, source.name));
		}
		for (const input of inputs) {
			if ((await stat(input)).mtimeMs > entry.mtimeMs)
				throw new BenchTargetError(
					`stale target ${root}: ${relative(root, input)} is newer than the ${label} build (run bun run build)`,
				);
		}
	}
}

export async function targetRevision(target: string): Promise<string> {
	const result = await runProcess(["git", "rev-parse", "HEAD"], { cwd: target });
	if (result.exitCode !== 0) throw new BenchTargetError(`target is not a git checkout: ${target}`);
	return result.stdout.trim();
}
