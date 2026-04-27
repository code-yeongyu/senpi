export const MERGED_COMPACTION_PROMPT_SYSTEM = "";
export const MERGED_COMPACTION_PROMPT_USER = "";
export const MERGED_COMPACTION_PROMPT_UPDATE = "";
export const MERGED_COMPACTION_PROMPT_BRANCH = "";
export const MERGED_COMPACTION_PROMPT_TURN_PREFIX = "";

export function buildPrompt(_options: unknown): { system: string; user: string } {
	return { system: "", user: "" };
}
