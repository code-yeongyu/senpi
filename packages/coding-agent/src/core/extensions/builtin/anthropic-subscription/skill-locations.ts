import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import { skillDisplayPath, skillDisplayRoot } from "../../../skill-read-paths.ts";

function expandDisplayPath(candidate: string, cwd: string): string {
	if (candidate === "~") return homedir();
	if (candidate.startsWith("~/")) return join(homedir(), candidate.slice(2));
	return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

function resolvesToSameFile(candidate: string, path: string, cwd: string): boolean {
	try {
		return realpathSync(expandDisplayPath(candidate, cwd)) === realpathSync(expandDisplayPath(path, cwd));
	} catch {
		return false;
	}
}

function claudeSkillsPath(path: string, cwd: string, sessionId: string | undefined, isRoot: boolean): string {
	const targets = [
		[join(getAgentDir(), "skills"), "~/.claude/skills"],
		[join(cwd, CONFIG_DIR_NAME, "skills"), ".claude/skills"],
	] as const;
	for (const [root, claudeRoot] of targets) {
		const inside = relative(root, path);
		if (inside !== "" && (/^\.\.(?:[\\/]|$)/.test(inside) || isAbsolute(inside))) continue;
		const candidate = inside === "" ? claudeRoot : `${claudeRoot}/${inside.split(sep).join("/")}`;
		if (resolvesToSameFile(candidate, path, cwd)) return candidate;
		return isRoot ? skillDisplayRoot(path, sessionId) : skillDisplayPath(path, sessionId);
	}
	return path;
}

function decodePath(path: string): string {
	return path
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function encodePath(path: string): string {
	return path
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function extractSkillsAppend(
	systemPrompt: string | undefined,
	cwd: string,
	sessionId: string | undefined,
): string | undefined {
	if (!systemPrompt) return undefined;
	const marker = "The following skills provide specialized instructions for specific tasks.";
	const start = systemPrompt.indexOf(marker);
	const end = start === -1 ? -1 : systemPrompt.indexOf("</available_skills>", start);
	if (end === -1) return undefined;
	const skillsBlock = systemPrompt.slice(start, end + "</available_skills>".length).trim();
	const rewrite = (path: string, isRoot: boolean) =>
		encodePath(claudeSkillsPath(decodePath(path), cwd, sessionId, isRoot));
	// Only the catalog carries display aliases. Loaded resource metadata continues to
	// identify real files, which the read tool uses to authorize and execute the call.
	const withRoots = skillsBlock.replace(/<skill_roots>[\s\S]*?<\/skill_roots>/, (table) =>
		table.replace(
			/<(r\d+)>([^<]+)<\/\1>/g,
			(_match, alias: string, root: string) => `<${alias}>${rewrite(root, true)}</${alias}>`,
		),
	);
	return withRoots.replace(
		/<location>([^<]+)<\/location>/g,
		(_match, location: string) => `<location>${rewrite(location, false)}</location>`,
	);
}
