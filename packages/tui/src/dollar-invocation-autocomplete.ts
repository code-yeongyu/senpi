import type { AutocompleteItem, SlashCommand } from "./autocomplete.ts";
import { fuzzyFilter } from "./fuzzy.ts";

const SKILL_COMMAND_PREFIX = "skill:";
const DOLLAR_QUERY_PATTERN = /^\$([a-zA-Z0-9:_-]*)$/;
const DOLLAR_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const COMMON_SHELL_VARIABLES = new Set([
	"CI",
	"EDITOR",
	"HOME",
	"LANG",
	"LC_ALL",
	"NODE_ENV",
	"OLDPWD",
	"PATH",
	"PWD",
	"SHELL",
	"SHLVL",
	"TERM",
	"TMPDIR",
	"USER",
	"VISUAL",
]);

type DollarInvocationItem = {
	readonly description?: string;
	readonly kind: "command" | "skill";
	readonly label: string;
	readonly searchText: string;
	readonly value: string;
};

export interface DollarInvocationContext {
	readonly prefix: string;
	readonly query: string;
	readonly skillsOnly: boolean;
}

export interface DollarSkillMention {
	readonly start: number;
	readonly end: number;
	readonly name: string;
}

function isDollarQueryCompletable(query: string): boolean {
	if (query === "") return true;
	if (query.startsWith("-") || query.startsWith("_") || /^\d/.test(query)) return false;
	return !COMMON_SHELL_VARIABLES.has(query);
}

function commandName(command: SlashCommand | AutocompleteItem): string {
	return "name" in command ? command.name : command.value;
}

function skillName(name: string): string | null {
	if (!name.startsWith(SKILL_COMMAND_PREFIX)) return null;
	const value = name.slice(SKILL_COMMAND_PREFIX.length);
	return value || null;
}

function commandDescription(command: SlashCommand | AutocompleteItem): string | undefined {
	const hint = "argumentHint" in command && command.argumentHint ? command.argumentHint : undefined;
	const description = command.description ?? "";
	if (hint) return description ? `${hint} — ${description}` : hint;
	return description || undefined;
}

/**
 * Locate every `$name` / `$skill:name` token on one line that names a known
 * skill. Tokens must sit at a whitespace boundary, so `$HOME`, `$1`, `a$x`,
 * and unknown names stay plain. Offsets are line-local and `end` is exclusive.
 */
export function findDollarSkillMentions(line: string, knownSkills: ReadonlySet<string>): DollarSkillMention[] {
	if (knownSkills.size === 0) return [];
	const mentions: DollarSkillMention[] = [];
	for (const match of line.matchAll(DOLLAR_MENTION_PATTERN)) {
		const token = match[2] ?? "";
		const name = token.startsWith(SKILL_COMMAND_PREFIX) ? token.slice(SKILL_COMMAND_PREFIX.length) : token;
		if (!knownSkills.has(name)) continue;
		const start = match.index + (match[1] ?? "").length;
		mentions.push({ start, end: start + token.length + 1, name });
	}
	return mentions;
}

/** Names of the skills the command list exposes as `skill:<name>` entries. */
export function knownSkillNames(commands: readonly (SlashCommand | AutocompleteItem)[]): ReadonlySet<string> {
	return new Set(
		commands.flatMap((command) => {
			const name = skillName(commandName(command));
			return name ? [name] : [];
		}),
	);
}

/**
 * Describe the `$` token under the cursor when it should open the popup.
 *
 * Any `$query` at a whitespace boundary completes, however many `$` tokens
 * precede it, so one prompt can carry several skill mentions. Slash commands
 * are only offered while the token is the first thing in the prompt; a token
 * that already names a known skill closes the popup so `enter` submits.
 */
export function getDollarInvocationContext(
	textBeforeCursor: string,
	_cursorLine: number,
	commands: readonly (SlashCommand | AutocompleteItem)[],
): DollarInvocationContext | null {
	const tokenStart = textBeforeCursor.search(/\S+$/);
	const token = tokenStart === -1 ? "" : textBeforeCursor.slice(tokenStart);
	const match = DOLLAR_QUERY_PATTERN.exec(token);
	if (!match) return null;

	const rawQuery = match[1] ?? "";
	if (!isDollarQueryCompletable(rawQuery)) return null;
	const explicitSkillNamespace = rawQuery.startsWith(SKILL_COMMAND_PREFIX);
	const query = explicitSkillNamespace ? rawQuery.slice(SKILL_COMMAND_PREFIX.length) : rawQuery;
	if (knownSkillNames(commands).has(query)) return null;
	const isFirstToken = textBeforeCursor.slice(0, tokenStart).trim() === "";
	return {
		prefix: `$${rawQuery}`,
		query,
		skillsOnly: explicitSkillNamespace || !isFirstToken,
	};
}

export function getDollarInvocationSuggestions(
	commands: readonly (SlashCommand | AutocompleteItem)[],
	query: string,
	skillsOnly: boolean,
): AutocompleteItem[] {
	const items: DollarInvocationItem[] = commands.flatMap((command): DollarInvocationItem[] => {
		const name = commandName(command);
		const skill = skillName(name);
		if (skill) {
			return [
				{
					kind: "skill" as const,
					value: `$${skill}`,
					label: `$${skill}`,
					searchText: skill,
					description: commandDescription(command),
				},
			];
		}
		if (skillsOnly) return [];
		return [
			{
				kind: "command" as const,
				value: `/${name}`,
				label: `/${name}`,
				searchText: name,
				description: commandDescription(command),
			},
		];
	});

	return fuzzyFilter(items, query, (item) => item.searchText)
		.map((item, index) => ({ ...item, index }))
		.sort((left, right) => {
			if (left.kind !== right.kind) return left.kind === "command" ? -1 : 1;
			return left.index - right.index;
		})
		.map(({ index: _index, kind: _kind, searchText: _searchText, ...item }) => item);
}
