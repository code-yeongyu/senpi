import type { AutocompleteItem, SlashCommand } from "./autocomplete.ts";
import { fuzzyFilter } from "./fuzzy.ts";

const SKILL_COMMAND_PREFIX = "skill:";
const DOLLAR_QUERY_PATTERN = /^\$([a-zA-Z0-9:_-]*)$/;
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

function isDollarQueryCompletable(query: string): boolean {
	if (query === "") return true;
	if (query.startsWith("-") || query.startsWith("_") || /^\d/.test(query)) return false;
	return !COMMON_SHELL_VARIABLES.has(query);
}

function leadingKnownSkillRun(text: string, knownSkills: ReadonlySet<string>): boolean {
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	return (
		tokens.length > 0 &&
		tokens.every((token) => {
			const match = DOLLAR_QUERY_PATTERN.exec(token);
			if (match === null || match[1] === "") return false;
			const name = match[1].startsWith(SKILL_COMMAND_PREFIX)
				? match[1].slice(SKILL_COMMAND_PREFIX.length)
				: match[1];
			return name !== "" && knownSkills.has(name);
		})
	);
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

export function getDollarInvocationContext(
	textBeforeCursor: string,
	_cursorLine: number,
	commands: readonly (SlashCommand | AutocompleteItem)[],
): DollarInvocationContext | null {
	const knownSkills = new Set(
		commands.flatMap((command) => {
			const name = skillName(commandName(command));
			return name ? [name] : [];
		}),
	);
	const tokenStart = textBeforeCursor.search(/\S+$/);
	const token = tokenStart === -1 ? "" : textBeforeCursor.slice(tokenStart);
	const match = DOLLAR_QUERY_PATTERN.exec(token);
	if (!match) return null;

	const rawQuery = match[1];
	if (!isDollarQueryCompletable(rawQuery)) return null;
	const explicitSkillNamespace = rawQuery.startsWith(SKILL_COMMAND_PREFIX);
	const precedingText = tokenStart === -1 ? "" : textBeforeCursor.slice(0, tokenStart);
	const hasEarlierDollarToken = precedingText.includes("$");
	const hasKnownLeadingSkillRun = leadingKnownSkillRun(precedingText, knownSkills);
	if (hasEarlierDollarToken && !hasKnownLeadingSkillRun) return null;
	const isKnownSkillInOrdinaryText = !hasKnownLeadingSkillRun && knownSkills.has(rawQuery);
	if (isKnownSkillInOrdinaryText) return null;
	return {
		prefix: `$${rawQuery}`,
		query: explicitSkillNamespace ? rawQuery.slice(SKILL_COMMAND_PREFIX.length) : rawQuery,
		skillsOnly: hasKnownLeadingSkillRun || explicitSkillNamespace,
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
