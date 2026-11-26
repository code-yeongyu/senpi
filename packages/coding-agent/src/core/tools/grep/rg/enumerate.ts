import { realpath, stat } from "node:fs/promises";
import { identityWalk } from "@code-yeongyu/senpi-machine-ops";
import { basename, dirname, relative, resolve } from "node:path";
import { GrepEngineError, type GrepEngineRequest, type GrepEngineResult } from "../engine.ts";
import { containsNul } from "./pinned-files.ts";
import { pathOrder, slashPath } from "./paths.ts";
import { MAX_FILE_BYTES } from "./prefix-pass.ts";
import type { RgRun } from "./process.ts";

export interface Root {
	path: string;
	alias: string;
	cwd: string;
	/** rg searches an explicitly named file as-is: no walk, ignore, glob, type or size filter applies. */
	file: boolean;
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
			roots.push({
				path: canonical,
				alias: path,
				cwd: info.isDirectory() ? canonical : dirname(canonical),
				file: info.isFile(),
			});
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
	budget?: number | undefined;
}): Promise<Candidate[]> {
	const candidates = new Map<string, Omit<Candidate, "ordinal" | "binary">>();
	for (const root of roots) {
		const policy = await identityWalk(root.path);
		const prune = policy.globs.flatMap((glob) => ["-g", "!" + glob]);
		// rg --sort uses the serial ignore walker. Even a skipped directory gets
		// add_child() there, which opens its rule files. The parallel walker filters
		// the child before scheduling it. Candidate order is established below.
		const order = prune.length ? ["--threads", "2"] : ["--sort", "path"];
		const listed = root.file
			? [root.path]
			: (await run(["--files", "--null", ...order, ...walk, ...prune, "--", root.path], root.cwd))
					.toString("utf8")
					.split("\0")
					.filter(Boolean);
		for (const path of listed) {
			check();
			const absolute = resolve(root.cwd, path);
			const [canonical, info] = await Promise.all([realpath(absolute), stat(absolute)]).catch((error) => {
				// A named file that vanished after root resolution fails like rg's own listing did.
				if (root.file && (error as NodeJS.ErrnoException).code === "ENOENT")
					throw new GrepEngineError("ENGINE_UNAVAILABLE", `${root.path}: No such file or directory`);
				throw error;
			});
			const alias = resolve(root.alias, relative(root.path, absolute));
			const display = slashPath(relative(cwd, alias)) || basename(alias);
			const existing = candidates.get(canonical);
			if (!existing || pathOrder(display, existing.display) < 0)
				candidates.set(canonical, { absolute, canonical, display, root, size: info.size });
		}
	}
	const binaryPaths = new Set<string>();
	// rg ignores --max-filesize for explicit file roots (the facade's second phase).
	// Oversized roots must be classified solely by the bounded prefix pass.
	for (const candidate of candidates.values()) {
		check();
		if (candidate.size <= MAX_FILE_BYTES && (await containsNul(candidate.absolute)))
			binaryPaths.add(candidate.canonical);
	}
	result.skippedBinary = [...binaryPaths].filter((path) => candidates.has(path)).length;
	return [...candidates.values()]
		.sort((a, b) => pathOrder(a.display, b.display))
		.map((candidate, index) => ({ ...candidate, ordinal: index + 1, binary: binaryPaths.has(candidate.canonical) }));
}
