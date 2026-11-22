import {
	parseSkillMcpDeclarations,
	type SkillLike,
	type SkillMcpDeclarations,
	skillActivationTargets,
} from "./skills.ts";

type McpRegisteredTool = { name: string; toolName: string; server: string };

interface McpSkillRevealState {
	declarations: SkillMcpDeclarations;
	skills: Map<string, SkillLike>;
	readonly loaded: Set<string>;
}

export interface McpSkillReveal {
	/** The skills this scope's turn lists; its declarations are returned so the caller attaches their servers. */
	startTurn(scope: object, skills: readonly SkillLike[]): SkillMcpDeclarations;
	/** The skills this scope's turn listed, to recognize a read of a skill's own file. */
	skills(scope: object): Iterable<[string, SkillLike]>;
	/** Reveal one skill for this scope: a skill it never listed, or already revealed, reveals nothing again. */
	reveal(scope: object, skillName: string): void;
}

/**
 * Skills-carry-MCP reveal state, per execution scope (brain/hand S16c). A runtime serving several scopes keeps one
 * state per scope, so one scope's turn does not replace another's skills and one scope's `/skill:<name>` does not
 * use up another's reveal of the same skill. A runtime serving one scope keeps exactly one state, as before.
 */
export function createMcpSkillReveal(options: {
	readonly registered: () => ReadonlyArray<McpRegisteredTool>;
	readonly activate: (targets: string[]) => void;
}): McpSkillReveal {
	const states = new WeakMap<object, McpSkillRevealState>();
	const stateOf = (scope: object): McpSkillRevealState => {
		const existing = states.get(scope);
		if (existing !== undefined) return existing;
		const created: McpSkillRevealState = {
			declarations: { servers: new Map(), warnings: [] },
			skills: new Map(),
			loaded: new Set(),
		};
		states.set(scope, created);
		return created;
	};
	return {
		startTurn(scope, skills) {
			const state = stateOf(scope);
			state.skills = new Map(skills.map((skill) => [skill.name, skill]));
			state.declarations = parseSkillMcpDeclarations(skills);
			return state.declarations;
		},
		skills(scope) {
			return stateOf(scope).skills;
		},
		reveal(scope, skillName) {
			const state = stateOf(scope);
			if (state.loaded.has(skillName) || !state.skills.has(skillName)) return;
			state.loaded.add(skillName);
			const targets = skillActivationTargets(state.declarations, skillName, options.registered());
			if (targets.length > 0) options.activate(targets);
		},
	};
}
