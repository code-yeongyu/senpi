/**
 * The kill guard's judge (senpi#5349, code-yeongyu/oh-my-openagent#12096): decides whether an agent-issued signal
 * may run. Dependency-free (only `node:` builtins and relative imports), so a codemode worker can import this file by
 * path in every runtime; the host reaches it through `./host.ts`.
 */
export { judgeArgv, judgeCommand, judgeSignal } from "./command.ts";
export { type PatternMode, type PatternVerdict, judgePattern } from "./pattern.ts";
// The codemode JS worker imports this file by URL (`kill-guard/host.ts` KILL_GUARD_MODULE_URL, read in
// senpi-codemode's `worker-kill-guard.js`), so knip cannot see the three names it calls.
export {
	type KillGuardContextOptions,
	type KillGuardSpawnSync,
	/** @public read by senpi-codemode's worker-kill-guard.js through KILL_GUARD_MODULE_URL */
	killGuardContext,
	/** @public read by senpi-codemode's worker-kill-guard.js through KILL_GUARD_MODULE_URL */
	spawnSyncFromBun,
	/** @public read by senpi-codemode's worker-kill-guard.js through KILL_GUARD_MODULE_URL */
	spawnSyncFromNode,
} from "./process-view.ts";
export { decideKillGuardRequest, type KillGuardRequest, type KillGuardRequestOptions } from "./request.ts";
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
