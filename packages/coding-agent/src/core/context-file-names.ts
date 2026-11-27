/**
 * The file names `loadContextFileFromDir` (context-files.ts) probes in each directory, in precedence order. Exported on
 * its own, without the loader's imports, so tooling that must know what the CLI reads (the fused-equivalence
 * recorder's leak guard, senpi#7550) checks the same list instead of a copy that can fall behind.
 */
export const CONTEXT_FILE_NAMES: readonly string[] = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];
