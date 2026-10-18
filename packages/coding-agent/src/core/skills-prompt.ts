import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { Skill } from "./skills.ts";

export const COMPACT_SKILL_CATALOG_COUNT = 100;
export const COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES = 64 * 1024;
export const MAX_SKILL_CATALOG_BYTES = 48 * 1024;
const ONE_LINE_DESCRIPTION_MAX_CHARS = 160;

/** A catalog this large is listed by name plus a one-line description, since it rides on every request. */
export function isLargeSkillCatalog(skills: readonly Skill[]): boolean {
	if (skills.length > COMPACT_SKILL_CATALOG_COUNT) return true;
	const bytes = skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.description, "utf8"), 0);
	return bytes > COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES;
}

export function warnIfLargeSkillCatalog(skills: readonly Skill[]): ResourceDiagnostic[] {
	const catalog = buildSkillCatalog(skills, "read");
	if (!catalog.compact && !catalog.namesOnly) return [];
	return [
		{
			type: "warning",
			category: "size-limit",
			message: catalog.namesOnly
				? `The skills section is limited to ${MAX_SKILL_CATALOG_BYTES / 1024} KiB: descriptions were dropped and ${catalog.omitted} skills were omitted. Remove unused skills to shrink every request.`
				: `The skills catalog uses one-line descriptions to limit request size (above ${COMPACT_SKILL_CATALOG_COUNT} skills, ${COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES / 1024} KiB of descriptions, or ${MAX_SKILL_CATALOG_BYTES / 1024} KiB rendered). Remove unused skills to shrink every request.`,
		},
	];
}

function buildSkillCatalog(skills: readonly Skill[], fileReadTool: "read" | "bash") {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	const compact = isLargeSkillCatalog(visible);
	const options = { fileReadTool, compact, namesOnly: false, omitted: 0 };
	const prompt = renderSkills(visible, options);
	if (Buffer.byteLength(prompt) <= MAX_SKILL_CATALOG_BYTES) return { prompt, compact, namesOnly: false, omitted: 0 };
	const compactPrompt = compact ? prompt : renderSkills(visible, { ...options, compact: true });
	if (Buffer.byteLength(compactPrompt) <= MAX_SKILL_CATALOG_BYTES) {
		return { prompt: compactPrompt, compact: true, namesOnly: false, omitted: 0 };
	}
	const minimal = { ...options, namesOnly: true };
	const namesPrompt = renderSkills(visible, minimal);
	if (Buffer.byteLength(namesPrompt) <= MAX_SKILL_CATALOG_BYTES) {
		return { prompt: namesPrompt, compact, namesOnly: true, omitted: 0 };
	}
	let low = 0;
	let high = visible.length;
	while (low < high) {
		const count = Math.ceil((low + high) / 2);
		const candidate = renderSkills(visible.slice(0, count), { ...minimal, omitted: visible.length - count });
		if (Buffer.byteLength(candidate) <= MAX_SKILL_CATALOG_BYTES) low = count;
		else high = count - 1;
	}
	const omitted = visible.length - low;
	return {
		prompt: renderSkills(visible.slice(0, low), { ...minimal, omitted }),
		compact,
		namesOnly: true,
		omitted,
	};
}

function oneLineDescription(description: string): string {
	const firstLine = description.trim().split("\n", 1)[0]?.trim() ?? "";
	return firstLine.length <= ONE_LINE_DESCRIPTION_MAX_CHARS
		? firstLine
		: `${firstLine.slice(0, ONE_LINE_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
// Skill roots share long absolute prefixes across every skill under them; rendering
// that prefix per skill bills it once per skill. The roots table pays it once per
// distinct root and each location becomes a short alias/relative path. A one-line
// rule tells the model to expand aliases by joining them back to the root.
// `fileReadTool` lets a bash-only tool set still load skills: the loading rule names
// the tool the session actually has.
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" = "read"): string {
	return buildSkillCatalog(skills, fileReadTool).prompt;
}

function renderSkills(
	visibleSkills: readonly Skill[],
	options: {
		readonly fileReadTool: "read" | "bash";
		readonly compact: boolean;
		readonly namesOnly: boolean;
		readonly omitted: number;
	},
): string {
	if (visibleSkills.length === 0 && options.omitted === 0) {
		return "";
	}

	const rootByPath = new Map<string, string>();
	for (const skill of visibleSkills) {
		const dir = skill.filePath.split("/").slice(0, -2).join("/"); // parent of <name>/SKILL.md
		if (!rootByPath.has(dir)) rootByPath.set(dir, `r${rootByPath.size}`);
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		options.fileReadTool === "read"
			? "Use the read tool to load a skill's file when its description matches the task and its instructions would change the work; keyword overlap or mere availability is not a reason."
			: "Use bash to load a skill's file when its description matches the task and its instructions would change the work; keyword overlap or mere availability is not a reason.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<skill_roots>",
	];
	for (const [dir, alias] of rootByPath) {
		lines.push(`  <${alias}>${escapeXml(dir)}</${alias}>`);
	}
	lines.push(
		"</skill_roots>",
		"A location's `rN/` prefix expands to the matching root above.",
		"",
		"<available_skills>",
	);

	for (const skill of visibleSkills) {
		const dir = skill.filePath.split("/").slice(0, -2).join("/");
		const alias = rootByPath.get(dir);
		const relative = skill.filePath.startsWith(`${dir}/`) ? skill.filePath.slice(dir.length + 1) : skill.filePath;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		if (!options.namesOnly) {
			lines.push(
				`    <description>${escapeXml(options.compact ? oneLineDescription(skill.description) : skill.description)}</description>`,
			);
		}
		lines.push(`    <location>${escapeXml(`${alias}/${relative}`)}</location>`);
		lines.push("  </skill>");
	}

	if (options.omitted > 0) lines.push(`  <omitted_skills>${options.omitted}</omitted_skills>`);
	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
