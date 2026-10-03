import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePipRequirements, runPipInstall } from "./py-installer.ts";
import { publishNextRevision, type Revision } from "./revision-store.ts";

const execFileAsync = promisify(execFile);

export type EnvironmentMode = "managed" | "project";

export interface InstallReceipt {
	readonly manager: "pip";
	readonly mode: EnvironmentMode;
	readonly root: string;
	readonly revision: number;
	readonly requested: readonly string[];
	readonly resolved: readonly string[];
	readonly changed: boolean;
}

export function managedEnvironmentBase(artifactsDir: string, language: "py", abiTag: string): string {
	return join(artifactsDir, "environments", language, abiTag);
}

export function projectPythonBase(cwd: string): string {
	return join(cwd, ".senpi", "python-packages");
}

export async function pythonAbiTag(interpreter: string): Promise<string> {
	const { stdout } = await execFileAsync(interpreter, [
		"-c",
		"import sys, sysconfig; print(sys.implementation.cache_tag, sysconfig.get_platform(), sys.executable)",
	]);
	return createHash("sha256").update(stdout.trim()).digest("hex").slice(0, 12);
}

export async function installPythonPackages(input: {
	readonly base: string;
	readonly mode: EnvironmentMode;
	readonly interpreter: string;
	readonly requirements: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}): Promise<InstallReceipt> {
	const requested = parsePipRequirements(input.requirements);
	let stdout = "";
	const { revision } = await publishNextRevision(
		input.base,
		(staging) =>
			runPipInstall({
				interpreter: input.interpreter,
				root: staging,
				args: requested,
				cwd: input.cwd,
				signal: input.signal,
				onOutput: (stream, data) => {
					if (stream === "stdout") stdout += data;
					input.onOutput?.(stream, data);
				},
			}),
		input.signal,
	);
	const resolved = installedDistributions(stdout);
	return receipt(input.mode, revision, requested, resolved);
}

function receipt(
	mode: EnvironmentMode,
	revision: Revision,
	requested: readonly string[],
	resolved: readonly string[],
): InstallReceipt {
	return {
		manager: "pip",
		mode,
		root: revision.dir,
		revision: revision.number,
		requested,
		resolved,
		changed: resolved.length > 0,
	};
}

function installedDistributions(stdout: string): string[] {
	const line = stdout.split("\n").find((entry) => entry.startsWith("Successfully installed "));
	return line === undefined ? [] : line.slice("Successfully installed ".length).trim().split(/\s+/);
}
