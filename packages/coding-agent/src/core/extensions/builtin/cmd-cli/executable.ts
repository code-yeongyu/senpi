import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export class CmdCliNotInstalledError extends Error {
	readonly kind = "binary_missing" as const;

	constructor(
		message = "Command Code CLI (`cmd`) is not installed. Ensure cmd is on your PATH or configure cmdCliProvider.executablePath.",
	) {
		super(message);
		this.name = "CmdCliNotInstalledError";
	}
}

export interface CmdCliExecutableDeps {
	readonly env?: (name: string) => string | undefined;
	readonly settings?: { executablePath?: string };
	readonly pathDelimiter?: string;
	readonly isExecutableFile?: (candidate: string) => boolean;
}

function isExecutableFileOnDisk(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function defaultCmdCliExecutableDeps(): CmdCliExecutableDeps {
	return {
		env: (name) => process.env[name],
		settings: {},
		pathDelimiter: delimiter,
		isExecutableFile: isExecutableFileOnDisk,
	};
}

function executableCandidate(candidate: string | undefined, deps: CmdCliExecutableDeps): string | undefined {
	if (!candidate || candidate.trim().length === 0) return undefined;
	const isExec = deps.isExecutableFile ?? isExecutableFileOnDisk;
	try {
		return isExec(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function resolveFromPath(deps: CmdCliExecutableDeps): string | undefined {
	const envGetter = deps.env ?? ((name) => process.env[name]);
	const pathValue = envGetter("PATH");
	if (!pathValue) return undefined;

	const sep = deps.pathDelimiter ?? delimiter;
	for (const directory of pathValue.split(sep)) {
		if (!directory) continue;
		const candidate = executableCandidate(join(directory, "cmd"), deps);
		if (candidate) return candidate;
		if (process.platform === "win32") {
			const winCandidate = executableCandidate(join(directory, "cmd.exe"), deps);
			if (winCandidate) return winCandidate;
		}
	}
	return undefined;
}

export function resolveCmdCliExecutable(deps: CmdCliExecutableDeps = defaultCmdCliExecutableDeps()): string {
	const envGetter = deps.env ?? ((name) => process.env[name]);
	const orderedCandidates = [
		envGetter("SENPI_CMD_CLI_EXECUTABLE"),
		envGetter("CMD_EXECUTABLE"),
		deps.settings?.executablePath,
	];

	for (const candidate of orderedCandidates) {
		const executable = executableCandidate(candidate, deps);
		if (executable) return executable;
	}

	const pathExecutable = resolveFromPath(deps);
	if (pathExecutable) return pathExecutable;

	throw new CmdCliNotInstalledError();
}
