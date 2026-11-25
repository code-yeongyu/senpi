import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const INSTALLATION_GUIDE = "https://antigravity.google/docs/cli/installation";

export class AgyNotInstalledError extends Error {
	constructor(tried: readonly string[] = []) {
		super(
			`Antigravity CLI (agy) is not installed. Install it from ${INSTALLATION_GUIDE}.` +
				(tried.length > 0 ? ` Tried: ${tried.join(", ")}` : ""),
		);
		this.name = "AgyNotInstalledError";
	}
}

export type AgyExecutableDeps = {
	env: Record<string, string | undefined>;
	homedir: string;
	pathExists(path: string): boolean;
	isExecutable(path: string): boolean;
};

export function defaultAgyExecutableDeps(): AgyExecutableDeps {
	return {
		env: process.env,
		homedir: homedir(),
		pathExists: existsSync,
		isExecutable: (path) => {
			try {
				accessSync(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}

export function resolveAgyExecutable(
	settings: { executablePath?: string },
	deps: AgyExecutableDeps = defaultAgyExecutableDeps(),
): string {
	const tried: string[] = [];
	const accept = (candidate: string | undefined): string | undefined => {
		if (!candidate) return undefined;
		tried.push(candidate);
		try {
			return deps.pathExists(candidate) && deps.isExecutable(candidate) ? candidate : undefined;
		} catch {
			return undefined;
		}
	};
	const explicit = [deps.env.SENPI_ANTIGRAVITY_ACP_EXECUTABLE, settings.executablePath];
	for (const candidate of explicit) {
		const executable = accept(candidate);
		if (executable !== undefined) return executable;
	}

	const executableNames = process.platform === "win32" ? ["agy", "agy.exe"] : ["agy"];
	for (const directory of (deps.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const name of executableNames) {
			const executable = accept(join(directory, name));
			if (executable !== undefined) return executable;
		}
	}

	const fallbacks = [
		join(deps.homedir, ".local", "bin", "agy"),
		join(deps.homedir, ".local", "share", "mise", "shims", "agy"),
	];
	for (const candidate of fallbacks) {
		const fallback = accept(candidate);
		if (fallback !== undefined) return fallback;
	}
	throw new AgyNotInstalledError(tried);
}
