import type { AutocompleteItem, SlashCommand } from "./autocomplete.ts";
import { fuzzyFilter } from "./fuzzy.ts";

const SKILL_COMMAND_PREFIX = "skill:";
const LEADING_DOLLAR_RUN_PATTERN = /^((?:\$[a-zA-Z][a-zA-Z0-9:_-]*\s+)*)\$([a-zA-Z0-9:_-]*)$/;

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
	cursorLine: number,
	commands: readonly (SlashCommand | AutocompleteItem)[],
): DollarInvocationContext | null {
	if (cursorLine !== 0) return null;
	const match = textBeforeCursor.match(LEADING_DOLLAR_RUN_PATTERN);
	if (!match) return null;

	const knownSkills = new Set(
		commands.flatMap((command) => {
			const name = skillName(commandName(command));
			return name ? [name] : [];
		}),
	);
	const precedingSkills = match[1]
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.slice(1))
		.map((name) => (name.startsWith(SKILL_COMMAND_PREFIX) ? name.slice(SKILL_COMMAND_PREFIX.length) : name));
	if (precedingSkills.some((name) => !knownSkills.has(name))) return null;

	const rawQuery = match[2];
	const explicitSkillNamespace = rawQuery.startsWith(SKILL_COMMAND_PREFIX);
	return {
		prefix: `$${rawQuery}`,
		query: explicitSkillNamespace ? rawQuery.slice(SKILL_COMMAND_PREFIX.length) : rawQuery,
		skillsOnly: precedingSkills.length > 0 || explicitSkillNamespace,
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
