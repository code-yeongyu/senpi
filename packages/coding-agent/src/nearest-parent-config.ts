import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, normalize } from "node:path";

export const MAX_PARENT_CONFIG_SEARCH_DEPTH = 100;

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** The account-database home, normalized; the walk never crosses it (#6459). */
function realAccountHomeDir(): string | undefined {
	try {
		return normalize(userInfo().homedir);
	} catch {
		return undefined;
	}
}

/**
 * Finds the nearest non-symlinked config directory between cwd and home.
 * Home is excluded so its config remains the global fallback layer. The walk also stops
 * at the account-database home, so a redirected `$HOME` (tests, sandboxes) can never
 * adopt the real account's config directory as project config (#6459).
 *
 * A flat-layout product has no marker subdirectory to look for, so it passes
 * `requiredChildFile` instead: the directory only counts as a config directory when it
 * actually holds that file. Without it, any same-named directory used for something else
 * would be mistaken for agent config.
 */
export function findNearestParentConfigDir(
	cwd: string,
	homeDir: string,
	configDirName: string,
	requiredChildDir?: string,
	requiredChildFile?: string,
): string | undefined {
	const normalizedHomeDir = normalize(homeDir);
	const accountHomeDir = realAccountHomeDir();
	let currentDir = normalize(cwd);

	for (let depth = 0; depth <= MAX_PARENT_CONFIG_SEARCH_DEPTH; depth += 1) {
		if (currentDir === normalizedHomeDir || (accountHomeDir !== undefined && currentDir === accountHomeDir)) {
			return undefined;
		}

		const configDir = join(currentDir, configDirName);
		const hasRequiredChild = requiredChildFile
			? isFile(join(configDir, requiredChildFile))
			: !requiredChildDir || isDirectory(join(configDir, requiredChildDir));
		if (isDirectory(configDir) && hasRequiredChild) {
			return configDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}

	return undefined;
}
