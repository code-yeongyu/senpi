import { realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { GrepEngineError, type GrepEngineRequest, type GrepEngineResult } from "../engine.ts";
import { pathOrder, slashPath } from "./paths.ts";
import { MAX_FILE_BYTES } from "./prefix-pass.ts";
import type { RgRun } from "./process.ts";

export interface Root {
	path: string;
	alias: string;
	cwd: string;
}
export interface Candidate {
	absolute: string;
	canonical: string;
	display: string;
	root: Root;
	size: number;
	/** One-based position in the complete filtered candidate order, including binary files. */
	ordinal: number;
	binary: boolean;
}

export async function resolveRoots(request: GrepEngineRequest, result: GrepEngineResult): Promise<Root[]> {
	const roots: Root[] = [];
	for (const path of new Set(request.paths)) {
		try {
			const [info, canonical] = await Promise.all([stat(path), realpath(path)]);
			// Anchored rg globs use the OS cwd (canonical even for /var aliases on macOS).
			roots.push({ path: canonical, alias: path, cwd: info.isDirectory() ? canonical : dirname(canonical) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			result.missingPaths.push(path);
		}
	}
	if (roots.length === 0)
		throw new GrepEngineError("PATH_NOT_FOUND", `No search paths exist: ${request.paths.join(", ")}`);
	return roots;
}

export async function enumerateCandidates({
	roots,
	cwd,
	walk,
	run,
	check,
	result,
}: {
	roots: Root[];
	cwd: string;
	walk: string[];
	run: RgRun;
	check: () => void;
	result: GrepEngineResult;
}): Promise<Candidate[]> {
	const candidates = new Map<string, Omit<Candidate, "ordinal" | "binary">>();
	for (const root of roots) {
		const output = await run(["--files", "--null", "--sort", "path", ...walk, "--", root.path], root.cwd);
		for (const path of output.toString("utf8").split("\0").filter(Boolean)) {
			check();
			const absolute = resolve(root.cwd, path);
			const [canonical, info] = await Promise.all([realpath(absolute), stat(absolute)]);
			const alias = resolve(root.alias, relative(root.path, absolute));
			const display = slashPath(relative(cwd, alias)) || basename(alias);
			const existing = candidates.get(canonical);
			if (!existing || pathOrder(display, existing.display) < 0)
				candidates.set(canonical, { absolute, canonical, display, root, size: info.size });
		}
	}
	const binaryPaths = new Set<string>();
	// Scan the entire normal-size file, including NULs after rg's first search buffer.
	for (const root of roots) {
		// rg ignores --max-filesize for explicit file roots (the facade's second phase).
		// Oversized roots must be classified solely by the bounded prefix pass.
		if ((candidates.get(root.path)?.size ?? 0) > MAX_FILE_BYTES) continue;
		const output = await run(
			[
				"-a",
				"-l",
				"--null",
				"--sort",
				"path",
				"--encoding",
				"none",
				"--max-filesize",
				String(MAX_FILE_BYTES),
				...walk,
				"-e",
				"\\x00",
				"--",
				root.path,
			],
			root.cwd,
		);
		for (const path of output.toString("utf8").split("\0").filter(Boolean))
			binaryPaths.add(await realpath(resolve(root.cwd, path)));
	}
	result.skippedBinary = [...binaryPaths].filter((path) => candidates.has(path)).length;
	return [...candidates.values()]
		.sort((a, b) => pathOrder(a.display, b.display))
		.map((candidate, index) => ({ ...candidate, ordinal: index + 1, binary: binaryPaths.has(candidate.canonical) }));
}
