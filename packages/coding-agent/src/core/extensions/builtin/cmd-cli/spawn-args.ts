export type CmdCliArgsInput = {
	readonly model?: string;
	readonly effort?: string;
	readonly maxTurns?: number;
	readonly permissionMode?: string;
};

/**
 * Serialize command-line arguments for invoking Command Code CLI (`cmd`).
 * The prompt goes through stdin because a full context can exceed the per-argument size limit.
 * cmd executes its own tools; senpi does not execute them.
 */
export function buildCmdCliArgs({ model, effort, maxTurns, permissionMode }: CmdCliArgsInput): string[] {
	return [
		"-p",
		"--output-format",
		"json",
		...(model ? ["-m", model] : []),
		...(effort ? ["--effort", effort] : []),
		...(maxTurns !== undefined ? ["--max-turns", String(maxTurns)] : []),
		...(permissionMode ? ["--permission-mode", permissionMode] : []),
	];
}
