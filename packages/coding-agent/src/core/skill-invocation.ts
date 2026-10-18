export interface SkillInvocationPromptSkill {
	name: string;
	filePath: string;
	baseDir: string;
	body: string;
}

/** Format the user-attributed payload for one or more explicit skill invocations. */
export function formatSkillInvocationPrompt(
	skills: readonly SkillInvocationPromptSkill[],
	userRequest?: string,
): string {
	const skillBlocks = skills.map(
		(skill) =>
			`The user explicitly invoked the "${skill.name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill-instruction>`,
	);
	const expandedSkills = skillBlocks.join("\n\n");
	return userRequest && /\S/.test(userRequest)
		? `${expandedSkills}\n\n<user-request>\n${userRequest}\n</user-request>`
		: expandedSkills;
}

/** Parsed skill block from a user message */
export interface ParsedSkillBlockSkill {
	readonly name: string;
	readonly location: string;
	readonly content: string;
}

/** `name`/`location`/`content` mirror the first entry of `skills` for older callers. */
export interface ParsedSkillBlock extends ParsedSkillBlockSkill {
	readonly skills: readonly ParsedSkillBlockSkill[];
	readonly userMessage: string | undefined;
}

const SKILL_INSTRUCTION_PATTERN =
	/^The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill-instruction>/;

function matchSkillInstruction(text: string): { skill: ParsedSkillBlockSkill; length: number } | null {
	const match = text.match(SKILL_INSTRUCTION_PATTERN);
	if (!match || match[1] !== match[2]) return null;
	return { skill: { name: match[1], location: match[3], content: match[4] }, length: match[0].length };
}

function toParsedSkillBlock(
	skills: readonly ParsedSkillBlockSkill[],
	userMessage: string | undefined,
): ParsedSkillBlock | null {
	const first = skills[0];
	if (!first) return null;
	return { ...first, skills, userMessage };
}

/**
 * Parse every chained skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const first = matchSkillInstruction(text);
	if (first) {
		const skills = [first.skill];
		let remainder = text.slice(first.length);
		while (remainder.startsWith("\n\nThe user explicitly invoked the ")) {
			const chained = matchSkillInstruction(remainder.slice(2));
			if (!chained) return null;
			skills.push(chained.skill);
			remainder = remainder.slice(chained.length + 2);
		}
		const requestMatch = remainder.match(/^\n\n<user-request>\n([\s\S]*?)\n<\/user-request>$/);
		if (remainder && !requestMatch) return null;
		return toParsedSkillBlock(skills, requestMatch?.[1].trim() || undefined);
	}

	const legacyMatch = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!legacyMatch) return null;
	return toParsedSkillBlock(
		[{ name: legacyMatch[1], location: legacyMatch[2], content: legacyMatch[3] }],
		legacyMatch[4]?.trim() || undefined,
	);
}

export type SkillInvocationSyntax = "dollar" | "slash";

export interface SkillInvocationToken {
	name: string;
	syntax: SkillInvocationSyntax;
	start: number;
	end: number;
	position: "inline" | "leading";
}

export const MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT = 64;

const SKILL_NAMESPACE = "skill:";
const LEADING_SKILL_INVOCATION_PATTERN = /^(?:\/skill:([a-zA-Z][a-zA-Z0-9:_-]*)|\$([a-zA-Z][a-zA-Z0-9:_-]*))(?=\s|$)/;
const INLINE_DOLLAR_SKILL_INVOCATION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface ParseSkillInvocationOptions {
	/** Loaded skill names; a bare inline `$name` is executable only when it is one of them. */
	readonly knownSkillNames?: ReadonlySet<string>;
}

function inlineSkillName(token: string, knownSkillNames: ReadonlySet<string> | undefined): string | null {
	if (token.startsWith(SKILL_NAMESPACE)) return token.slice(SKILL_NAMESPACE.length) || null;
	return knownSkillNames?.has(token) ? token : null;
}

/**
 * Find explicit skill invocation tokens without treating ordinary inline dollar
 * prose (for example `$HOME`) as executable.
 *
 * Leading runs accept `/skill:name`, `$name`, and `$skill:name`. Outside the
 * leading run the explicit `$skill:name` token is always executable and a bare
 * `$name` is executable when it names a loaded skill.
 */
export function parseSkillInvocationTokens(
	text: string,
	options: ParseSkillInvocationOptions = {},
): SkillInvocationToken[] {
	const tokens: SkillInvocationToken[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
		const match = text.slice(cursor).match(LEADING_SKILL_INVOCATION_PATTERN);
		if (!match) break;
		const syntax: SkillInvocationSyntax = match[1] ? "slash" : "dollar";
		const dollarName = match[2];
		const name = match[1] ?? (dollarName?.startsWith("skill:") ? dollarName.slice("skill:".length) : dollarName);
		if (!name) break;
		tokens.push({
			name,
			syntax,
			start: cursor,
			end: cursor + match[0].length,
			position: "leading",
		});
		if (tokens.length >= MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT) return tokens;
		cursor += match[0].length;
	}

	INLINE_DOLLAR_SKILL_INVOCATION_PATTERN.lastIndex = cursor;
	for (const match of text.matchAll(INLINE_DOLLAR_SKILL_INVOCATION_PATTERN)) {
		const token = match[2] ?? "";
		const name = inlineSkillName(token, options.knownSkillNames);
		if (name === null) continue;
		const start = (match.index ?? 0) + (match[1] ?? "").length;
		tokens.push({
			name,
			syntax: "dollar",
			start,
			end: start + token.length + 1,
			position: "inline",
		});
		if (tokens.length >= MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT) break;
	}

	return tokens;
}

function stripLeadingInvocationSeparators(text: string): string {
	let cursor = 0;
	while (text[cursor] === " " || text[cursor] === "\t") cursor++;
	while (text[cursor] === "\n" || (text[cursor] === "\r" && text[cursor + 1] === "\n")) {
		cursor += text[cursor] === "\r" ? 2 : 1;
		const lineStart = cursor;
		while (text[cursor] === " " || text[cursor] === "\t") cursor++;
		if (text[cursor] !== "\n" && !(text[cursor] === "\r" && text[cursor + 1] === "\n")) {
			return text.slice(lineStart);
		}
	}
	return text.slice(cursor);
}

/**
 * Remove expanded invocation tokens, leaving `[skill: name]` where an inline one stood. Tokens in
 * `unloaded` were not expanded (per-prompt cap) and leave `[skill not loaded: name]` in either position,
 * so the model is told it does not have that skill instead of seeing a bare command.
 */
export function removeSkillInvocationTokens(
	text: string,
	tokens: readonly SkillInvocationToken[],
	unloaded: ReadonlySet<SkillInvocationToken> = new Set(),
): string {
	let cursor = 0;
	let result = "";
	for (const token of tokens) {
		result += text.slice(cursor, token.start);
		if (unloaded.has(token)) result += `[skill not loaded: ${token.name}]`;
		else if (token.position === "inline") result += `[skill: ${token.name}]`;
		cursor = token.end;
		if (
			token.position === "inline" &&
			(result.endsWith(" ") || result.endsWith("\t")) &&
			(text[cursor] === " " || text[cursor] === "\t")
		) {
			cursor++;
		}
	}
	result += text.slice(cursor);
	return tokens.some((token) => token.position === "leading") ? stripLeadingInvocationSeparators(result) : result;
}

/**
 * Default cap on explicit skill expansion so one prompt cannot consume unbounded context.
 * Users who compose more skills raise it with the `maxSkillExpansionsPerPrompt` setting.
 */
export const MAX_SKILL_EXPANSIONS_PER_PROMPT = 5;
