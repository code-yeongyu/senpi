import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { PROJECT_MARKERS } from "./constants.ts";

export function findProjectRoot(startPath: string, markers: ReadonlyArray<string> = PROJECT_MARKERS): string | null {
	const normalizedStartPath = resolve(startPath);

	if (!existsSync(normalizedStartPath)) {
		return null;
	}

	let resolvedStartPath: string;
	try {
		resolvedStartPath = realpathSync.native(normalizedStartPath);
	} catch {
		return null;
	}

	let currentDirectory: string;
	try {
		const startStats = statSync(resolvedStartPath);
		currentDirectory = startStats.isDirectory() ? resolvedStartPath : dirname(resolvedStartPath);
	} catch {
		return null;
	}
	const filesystemRoot = resolve("/");

	while (true) {
		for (const marker of markers) {
			if (existsSync(join(currentDirectory, marker))) {
				return currentDirectory;
			}
		}

		if (currentDirectory === filesystemRoot) {
			return null;
		}

		const parentDirectory = dirname(currentDirectory);
		// Cross-drive / UNC walk: dirname() of a drive root returns the root itself,
		// and a root on a different drive than cwd never equals resolve("/"), so the
		// walk would spin forever without this guard.
		if (parentDirectory === currentDirectory) {
			return null;
		}
		currentDirectory = parentDirectory;
	}
}

/**
 * Widen a marker-based project root to the enclosing git repository root.
 *
 * Monorepos (e.g. Cargo workspaces, pnpm workspaces) nest project markers: a
 * file inside `crates/<member>/src/` resolves its project root to the member
 * crate (`crates/<member>/Cargo.toml`), which stops the rule walk before it
 * reaches workspace-level `.github/instructions/` directories. Walking up to
 * the innermost `.git` instead lets rules placed at repository, workspace or
 * member level all participate — the scopeRelative path base keeps each rule's
 * glob semantics keyed to the directory that owns the rule file.
 *
 * A `.git` in the user's home directory (dotfiles repositories) is ignored: it
 * is not a meaningful rule boundary and would otherwise leak rules from `~`
 * into every marker-less project below it. When no `.git` exists above, the
 * project root is returned unchanged (plain upstream behaviour).
 */
export function widenToRepositoryRoot(projectRoot: string | null): string | null {
	if (projectRoot === null) {
		return null;
	}

	const repositoryFilesystemRoot = resolve("/");
	const homeDirectory = resolveExistingPath(homedir());
	let currentDirectory = resolveExistingPath(projectRoot);

	while (true) {
		if (currentDirectory === homeDirectory) {
			return projectRoot;
		}

		if (existsSync(join(currentDirectory, ".git"))) {
			return currentDirectory;
		}

		if (currentDirectory === repositoryFilesystemRoot) {
			return projectRoot;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return projectRoot;
		}

		currentDirectory = parentDirectory;
	}
}

function resolveExistingPath(path: string): string {
	try {
		return realpathSync.native(resolve(path));
	} catch {
		return resolve(path);
	}
}
