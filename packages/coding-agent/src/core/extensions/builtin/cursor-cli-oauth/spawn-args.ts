export type CursorCliArgsInput = {
	readonly prompt: string;
	readonly model?: string;
	readonly resumeChatId?: string;
	readonly force?: boolean;
	readonly executionMode?: "agent" | "plan";
	readonly sandboxMode?: string;
};

/** Serialize one Cursor CLI print-mode invocation without applying execution policy. */
export function buildCursorCliArgs({
	prompt,
	model,
	resumeChatId,
	force,
	executionMode,
	sandboxMode,
}: CursorCliArgsInput): string[] {
	return [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--stream-partial-output",
		"--trust",
		...(model ? ["--model", model] : []),
		...(resumeChatId ? ["--resume", resumeChatId] : []),
		...(force ? ["--force"] : []),
		...(executionMode === "plan" ? ["--mode", "plan"] : []),
		...(sandboxMode ? ["--sandbox", sandboxMode] : []),
	];
}
