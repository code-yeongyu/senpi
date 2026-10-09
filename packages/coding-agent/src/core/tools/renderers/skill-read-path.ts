/**
 * Display path for a file that lives inside a skill directory: `<skill>/<path inside the skill>`.
 *
 * A skill directory is the nearest ancestor holding a `SKILL.md`. The search never considers the cwd or
 * its ancestors (a session running inside a skill keeps its cwd-relative paths), the home directory, or
 * the filesystem root.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

/** Transcript projection asks on every frame, so each directory is probed at most once per cwd. */
const skillRootByDirectory = new Map<string, string | null>();
const SKILL_ROOT_CACHE_LIMIT = 2048;

function isSameOrInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function findSkillRoot(absolutePath: string, cwd: string): string | undefined {
	const home = homedir();
	const visited: string[] = [];
	let skillRoot: string | null = null;
	for (let directory = dirname(absolutePath); ; directory = dirname(directory)) {
		const key = `${cwd}\0${directory}`;
		const cached = skillRootByDirectory.get(key);
		if (cached !== undefined) {
			skillRoot = cached;
			break;
		}
		if (directory === dirname(directory) || directory === home || isSameOrInside(directory, cwd)) break;
		visited.push(key);
		if (existsSync(join(directory, "SKILL.md"))) {
			skillRoot = directory;
			break;
		}
	}
	if (skillRootByDirectory.size + visited.length > SKILL_ROOT_CACHE_LIMIT) skillRootByDirectory.clear();
	for (const key of visited) skillRootByDirectory.set(key, skillRoot);
	return skillRoot ?? undefined;
}

export function getSkillReadPath(absolutePath: string, cwd: string): string | undefined {
	const skillRoot = findSkillRoot(resolvePath(absolutePath), resolvePath(cwd));
	if (skillRoot === undefined) return undefined;
	return [basename(skillRoot), ...relative(skillRoot, absolutePath).split(sep)].join("/");
}
