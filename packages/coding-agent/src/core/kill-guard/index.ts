/**
 * The kill guard's judge (senpi#5349, code-yeongyu/oh-my-openagent#12096): decides whether an agent-issued signal
 * may run. Dependency-free (only `node:` builtins and relative imports), so a codemode worker can import this file by
 * path in every runtime; the host reaches it through `./host.ts`.
 */
export { judgeArgv, judgeCommand, judgeSignal } from "./command.ts";
export { type PatternMode, type PatternVerdict, judgePattern } from "./pattern.ts";
export {
	createProcessView,
	KILL_GUARD_DEADLINE_MS,
	type KillGuardContextOptions,
	type KillGuardSpawnSync,
	killGuardContext,
	parsePsRows,
	spawnSyncFromBun,
	spawnSyncFromNode,
} from "./process-view.ts";
export {
	decideKillGuardRequest,
	type KillGuardRequest,
	type KillGuardRequestOptions,
	parseKillGuardRequest,
} from "./request.ts";
export type {
	KillGuardContext,
	KillGuardRule,
	KillGuardShell,
	KillGuardVantage,
	KillGuardVerdict,
	ProcessRow,
	ProcessView,
	SelectResult,
	SignalCall,
} from "./types.ts";
export { KILL_GUARD_TAG } from "./verdict.ts";
