import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type CursorAgentDirectoryEntry = {
	name: string;
	isDirectory: boolean;
};

export type CursorAgentExecutableDeps = {
	env: (name: string) => string | undefined;
	settings: { executablePath?: string };
	homeDirectory: string;
	pathDelimiter: string;
	isExecutableFile: (candidate: string) => boolean;
	readDirectory: (directory: string) => CursorAgentDirectoryEntry[];
};

export type VersionProbeOptions = {
	encoding: "utf8";
	timeout: number;
};

export type VersionProbeCallback = (error: Error | null, stdout: string, stderr: string) => void;

export type VersionProbeDeps = {
	execFile: (file: string, args: string[], options: VersionProbeOptions, callback: VersionProbeCallback) => void;
};

export class CursorAgentNotInstalledError extends Error {
	readonly kind = "binary_missing";

	constructor() {
		super(
			"Cursor CLI is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, " +
				"then ensure ~/.local/bin is on your PATH.",
		);
		this.name = "CursorAgentNotInstalledError";
	}
}

function executableCandidate(candidate: string | undefined, deps: CursorAgentExecutableDeps): string | undefined {
	if (!candidate) return undefined;
	try {
		return deps.isExecutableFile(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function resolveFromPath(deps: CursorAgentExecutableDeps): string | undefined {
	const pathValue = deps.env("PATH");
	if (!pathValue) return undefined;

	for (const directory of pathValue.split(deps.pathDelimiter)) {
		if (!directory) continue;
		const candidate = executableCandidate(join(directory, "cursor-agent"), deps);
		if (candidate) return candidate;
	}
	return undefined;
}

function resolveFromInstalledVersions(deps: CursorAgentExecutableDeps): string | undefined {
	const versionsDirectory = join(deps.homeDirectory, ".local", "share", "cursor-agent", "versions");
	let entries: CursorAgentDirectoryEntry[];
	try {
		entries = deps.readDirectory(versionsDirectory);
	} catch {
		return undefined;
	}

	const directoryNames = entries
		.filter((entry) => entry.isDirectory)
		.map((entry) => entry.name)
		.sort()
		.reverse();

	for (const directoryName of directoryNames) {
		const candidate = executableCandidate(join(versionsDirectory, directoryName, "cursor-agent"), deps);
		if (candidate) return candidate;
	}
	return undefined;
}

export function resolveCursorAgentExecutable(deps: CursorAgentExecutableDeps): string {
	const orderedCandidates = [
		deps.env("SENPI_CURSOR_CLI_OAUTH_EXECUTABLE"),
		deps.env("CURSOR_AGENT_EXECUTABLE"),
		deps.settings.executablePath,
	];
	for (const candidate of orderedCandidates) {
		const executable = executableCandidate(candidate, deps);
		if (executable) return executable;
	}

	const pathExecutable = resolveFromPath(deps);
	if (pathExecutable) return pathExecutable;

	const installedExecutable = resolveFromInstalledVersions(deps);
	if (installedExecutable) return installedExecutable;

	throw new CursorAgentNotInstalledError();
}

const defaultVersionProbeDeps: VersionProbeDeps = {
	execFile: (file, args, options, callback) => {
		nodeExecFile(file, args, options, (error, stdout, stderr) => {
			callback(error, stdout, stderr);
		});
	},
};

export function probeCursorAgentVersion(
	executable: string,
	deps: VersionProbeDeps = defaultVersionProbeDeps,
): Promise<string> {
	return new Promise((resolve, reject) => {
		deps.execFile(executable, ["--version"], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout.trim());
		});
	});
}

export function defaultCursorAgentExecutableDeps(): CursorAgentExecutableDeps {
	return {
		env: (name) => process.env[name],
		settings: {},
		homeDirectory: homedir(),
		pathDelimiter: delimiter,
		isExecutableFile: (candidate) => {
			try {
				if (!statSync(candidate).isFile()) return false;
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
		readDirectory: (directory) =>
			readdirSync(directory, { withFileTypes: true }).map((entry) => ({
				name: entry.name,
				isDirectory: entry.isDirectory(),
			})),
	};
}
