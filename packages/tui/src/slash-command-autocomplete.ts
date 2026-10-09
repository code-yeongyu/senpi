import type { AutocompleteItem, SlashCommand } from "./autocomplete.ts";
import { fuzzyFilter } from "./fuzzy.ts";

const SKILL_COMMAND_PREFIX = "skill:";

/**
 * A slash item whose value ends in `:` names a command namespace (`skill:` = "Browse available
 * skills"), not a command: choosing it drills into that namespace's list instead of submitting.
 */
export function isSlashNamespaceItem(value: string): boolean {
	return value.endsWith(":");
}

type CommandItem = {
	readonly name: string;
	readonly label: string;
	readonly description?: string;
	readonly searchText: string;
	readonly awaitsArguments: boolean;
};

type RankedCommandItem = AutocompleteItem & {
	readonly index: number;
};

function compareSlashCommandSuggestion(prefix: string, left: RankedCommandItem, right: RankedCommandItem): number {
	const leftExact = left.value === prefix;
	const rightExact = right.value === prefix;
	if (leftExact !== rightExact) return leftExact ? -1 : 1;

	const leftPrefix = left.value.startsWith(prefix);
	const rightPrefix = right.value.startsWith(prefix);
	if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
	if (leftPrefix && rightPrefix && left.value.length !== right.value.length) {
		return right.value.length - left.value.length;
	}

	return left.index - right.index;
}

export function getSlashCommandSuggestions(
	commands: readonly (SlashCommand | AutocompleteItem)[],
	prefix: string,
): AutocompleteItem[] {
	const normalizedPrefix = prefix.toLowerCase();
	const explicitSkillNamespace = normalizedPrefix.startsWith(SKILL_COMMAND_PREFIX);
	const hasSkillCommands = commands.some((cmd) => {
		const name = "name" in cmd ? cmd.name : cmd.value;
		return name.startsWith(SKILL_COMMAND_PREFIX);
	});
	const commandItems: CommandItem[] = commands.flatMap((cmd) => {
		const name = "name" in cmd ? cmd.name : cmd.value;
		const isSkill = name.startsWith(SKILL_COMMAND_PREFIX);
		const skillName = isSkill ? name.slice(SKILL_COMMAND_PREFIX.length) : "";
		if (
			isSkill &&
			!explicitSkillNamespace &&
			(normalizedPrefix.length === 0 || !skillName.toLowerCase().startsWith(normalizedPrefix))
		) {
			return [];
		}

		const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
		// A hint without an explicit `requiresArguments` means the command expects input.
		const requiresArguments = ("requiresArguments" in cmd ? cmd.requiresArguments : undefined) ?? hint !== undefined;
		const desc = cmd.description ?? "";
		const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
		return [
			{
				name,
				label: name,
				description: fullDesc || undefined,
				searchText: isSkill && !explicitSkillNamespace ? skillName : name,
				awaitsArguments: requiresArguments || ("awaitsArguments" in cmd && cmd.awaitsArguments === true),
			},
		];
	});

	if (
		hasSkillCommands &&
		!explicitSkillNamespace &&
		normalizedPrefix.length > 0 &&
		SKILL_COMMAND_PREFIX.startsWith(normalizedPrefix)
	) {
		commandItems.push({
			name: SKILL_COMMAND_PREFIX,
			label: SKILL_COMMAND_PREFIX,
			description: "Browse available skills",
			searchText: SKILL_COMMAND_PREFIX,
			awaitsArguments: false,
		});
	}

	return fuzzyFilter(commandItems, prefix, (item) => item.searchText)
		.map((item, index) => ({
			value: item.name,
			label: item.label,
			...(item.description && { description: item.description }),
			...(item.awaitsArguments && { awaitsArguments: true }),
			index,
		}))
		.sort((left, right) => compareSlashCommandSuggestion(normalizedPrefix, left, right))
		.map(({ index: _index, ...item }) => item);
}
