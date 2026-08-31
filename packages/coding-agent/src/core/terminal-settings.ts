export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	// Persistent-terminal tool suite (builtin `terminal` extension) config.
	defaultCols?: number; // default: 120 (PTY width for new sessions)
	defaultRows?: number; // default: 40 (PTY height for new sessions)
	scrollback?: number; // default: 10000 (xterm scrollback lines per session)
	maxSessions?: number; // default: 32 (concurrent background sessions before LRU-exited pruning)
	timeoutAction?: "background" | "kill"; // default: "background" (fate of a foreground timeout)
	notify?: "wake" | "next-turn" | "off"; // default: "wake" (async completion wake behavior)
	monitorCoalesceWindowMs?: number; // default: 2000 (event batching window)
	monitorRateLimitMs?: number; // default: 5000 (minimum interval per monitor injection)
	monitorMaxLinesPerInjection?: number; // default: 50 (bounded monitor event batch)
	monitorMaxCharsPerInjection?: number; // default: 4096 (bounded monitor event batch)
	monitorWakeBudget?: number; // default: 5 (consecutive monitor-only wake limit)
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}
