import { resolve } from "node:path";
import { APPROVED_MONITOR_PARENT } from "../monitor-permission.ts";
import { allocateMonitorId, MonitorRegistry } from "../monitor-registry.ts";
import { ensureMonitorStateDir, terminalStateDir } from "../monitor-state-dir.ts";
import {
	DEFAULT_COLS,
	DEFAULT_ROWS,
	DURABLE_MONITOR_EXPIRY_MS,
	MONITOR_ENV_ID,
	MONITOR_ENV_STATE_DIR,
	TERMINAL_MONITOR_TOOL,
} from "../shared.ts";
import {
	errorResult,
	resolveTerminalId,
	type TerminalToolContext,
	type TerminalToolResult,
	textResult,
} from "./context.ts";
import {
	durableAdmissionError,
	handFileCheckpoint,
	handMonitorSpec,
	manifestSessionKey,
} from "./monitor-manifest-binding.ts";
import {
	compileFilter,
	isCreateInput,
	isFileCreateInput,
	type MonitorCreateInput,
	type MonitorInput,
	monitorSchema,
	resolveDimension,
	resolveTimeoutMs,
} from "./monitor-schema.ts";
import { renderMonitorCall } from "./render.ts";
import { spawnCommandSession } from "./spawn.ts";

export {
	bindTerminalManifestWriter,
	MAX_PENDING_MONITOR_SPECS,
	pendingDurableSpecCount,
	unbindTerminalManifestWriter,
} from "./monitor-manifest-binding.ts";
export {
	DEFAULT_MONITOR_TIMEOUT_MS,
	MAX_MONITOR_TIMEOUT_MS,
	type MonitorInput,
	monitorSchema,
} from "./monitor-schema.ts";

async function createMonitor(
	ctx: TerminalToolContext,
	registry: MonitorRegistry,
	input: MonitorCreateInput,
	execCtx: { cwd?: string } | undefined,
): Promise<TerminalToolResult> {
	let filter: RegExp | undefined;
	try {
		filter = compileFilter(input.filter);
	} catch {
		return errorResult(`Invalid monitor filter regex: ${input.filter}`);
	}

	// Durability needs an absolute directory: a restore runs in a different process whose
	// process cwd is unrelated, so the spec must carry the resolved path the spawn used.
	const cwd = resolve(execCtx?.cwd ?? ctx.cwd);
	const timeoutMs = input.persistent ? undefined : resolveTimeoutMs(input.timeout_ms);
	const deadlineMs = timeoutMs === undefined ? null : Date.now() + timeoutMs;
	// The stable id is allocated BEFORE the spawn so the command can see it in its environment.
	const monitorId = allocateMonitorId();
	const terminalDir = terminalStateDir(ctx.getSessionContext?.());
	const envOverrides: Record<string, string> = { [MONITOR_ENV_ID]: monitorId };
	if (input.persistent === true && terminalDir !== undefined) {
		envOverrides[MONITOR_ENV_STATE_DIR] = await ensureMonitorStateDir(terminalDir, monitorId);
	}
	const { id, runtime } = await spawnCommandSession(ctx, {
		command: input.command,
		cols: resolveDimension(undefined, ctx.defaultCols || DEFAULT_COLS),
		rows: resolveDimension(undefined, ctx.defaultRows || DEFAULT_ROWS),
		cwd,
		envOverrides,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	ctx.onMonitorRearmed?.(id);
	registry.register({
		monitorId,
		id,
		description: input.description,
		runtime,
		filter,
		command: input.command,
		persistent: input.persistent === true,
		deadlineMs,
		// Only persistent command watches are restartable-command durable: those carry the fire budget.
		durabilityClass: input.persistent === true ? "restartable-command" : "ephemeral",
		// Same deadline the manifest writer persists, so the footer warns off the live record too.
		...(input.persistent === true ? { expiresAt: Date.now() + DURABLE_MONITOR_EXPIRY_MS } : {}),
	});
	ctx.manager.bindMonitorId(monitorId, id);
	// The tool call site is the only place the branch inputs (command, persistent, filter)
	// live; hand the captured spec to the session's manifest writer for durable recording.
	const identity = runtime.identity();
	await handMonitorSpec(manifestSessionKey(ctx), {
		monitorId,
		spec: {
			kind: "command",
			description: input.description,
			command: input.command,
			filter: input.filter,
			cwd,
			persistent: input.persistent === true,
		},
		...(identity === undefined ? {} : { runtime: identity }),
		...(deadlineMs === null ? {} : { deadlineMs }),
	});
	return textResult(`Monitor started with ID: ${monitorId}`, {
		details: { monitor_id: monitorId, bash_id: id, monitor: true },
	});
}

/** Build the PTY-backed monitor tool. Monitor handles share TerminalManager's bash_N namespace. */
export function createMonitorTool(ctx: TerminalToolContext) {
	let fallbackRegistry: MonitorRegistry | undefined;
	const getRegistry = (): MonitorRegistry => {
		const sessionRegistry = ctx.monitorRegistry;
		if (sessionRegistry) return sessionRegistry;
		fallbackRegistry ??= new MonitorRegistry((event) => ctx.onMonitorEvent?.(event));
		return fallbackRegistry;
	};
	return {
		name: TERMINAL_MONITOR_TOOL,
		label: "monitor",
		description:
			"Subscribe to a change instead of polling. Pass command XOR path, never both: command watches a PTY session, injecting matching newline-terminated output lines (stderr merged) plus an exit summary; path natively watches one file and fires once, where create (the default) fires only when the file appears after registration, so use event modify for an existing file, and filter is rejected. Returns a bash_id immediately; peek with bash_output, stop with kill_bash.",
		promptSnippet:
			"Subscribe to a command's output or a file's create/modify event as injected events instead of polling",
		promptGuidelines: [
			"Waiting on observable state (CI checks, builds, log patterns, deploys, a file landing) means a monitor, never a foreground sleep/poll loop.",
			'Waiting for one file to appear or change is the path branch: `monitor({ description, path, event? })` beats wrapping `test -f` in a shell poll loop; a file that already exists needs `event: "modify"`, since `create` only fires on appearance, and registration needs the parent directory to exist already — when the run creates that directory too, use the `command` branch instead.',
			"Shape the command for the events you need: one-shot gate = `until <cond>; do sleep 1; done; printf 'READY\\n'` with filter ^READY$; stream = `tail -n 0 -F <log> | grep --line-buffered <pat>` with persistent: true, then kill_bash.",
			'Persistent command watches are re-run after a restart with `SENPI_MONITOR_RESTORED=1`; keep any baseline in `$SENPI_MONITOR_STATE_DIR` so a move during downtime (at most `$SENPI_MONITOR_DOWNTIME_MS` ms) is still reported: `b="$SENPI_MONITOR_STATE_DIR/base"; p=$(cat "$b" 2>/dev/null || git rev-parse origin/main | tee "$b"); while sleep 30; do git fetch -q || true; n=$(git rev-parse origin/main); [ "$n" != "$p" ] && { echo "MOVED $p..$n"; p=$n; echo "$p" > "$b"; }; done`. A watch whose command exits is not restarted, so keep failures inside the loop non-fatal.',
			"Sleep loops belong INSIDE the monitor command, never in your turn: about to sleep, re-poll bash_output, or foreground-block on a long command means register a monitor and keep working.",
		],
		parameters: monitorSchema,
		renderCall: renderMonitorCall,
		async execute(
			_toolCallId: string,
			input: MonitorInput,
			_signal?: AbortSignal,
			_onUpdate?: undefined,
			execCtx?: { cwd?: string },
		): Promise<TerminalToolResult> {
			const registry = getRegistry();
			if (input.action === "rearm") {
				if (input.bash_id === undefined || input.bash_id.length === 0) {
					const resumed = registry.resume();
					if (resumed.length === 0) return textResult("No paused monitors to re-arm.");
					ctx.onMonitorsResumed?.(resumed.map((monitor) => monitor.id));
					const total = resumed.reduce((sum, monitor) => sum + monitor.mutedDropped, 0);
					return textResult(
						total > 0
							? `Re-armed ${resumed.length} paused monitor(s) (${total} line(s) dropped while muted).`
							: `Re-armed ${resumed.length} paused monitor(s).`,
					);
				}
				const bashId = resolveTerminalId(ctx.manager, input.bash_id);
				const dropped = registry.mutedDropped(bashId);
				const outcome = registry.rearm(bashId);
				if (outcome === "not_found") return errorResult(`No active monitor found with id: ${bashId}`);
				if (outcome === "not_paused") return textResult(`Monitor ${bashId} is not paused; no action taken.`);
				ctx.onMonitorRearmed?.(bashId);
				return textResult(
					dropped > 0
						? `Monitor ${bashId} re-armed (${dropped} line(s) dropped while muted).`
						: `Monitor ${bashId} re-armed.`,
				);
			}
			const fileInput = isFileCreateInput(input);
			const commandInput = isCreateInput(input);
			if (fileInput && commandInput) return errorResult("monitor accepts either command or path, not both.");
			// Every create binds persistence first (lazy lease + recorder: an ephemeral watch with time
			// left is restorable too), then durable admission runs before either create branch touches
			// a PTY or the registry.
			if (fileInput || commandInput) await ctx.ensurePersistence?.();
			if (input.persistent === true && (fileInput || commandInput)) {
				const refused = durableAdmissionError(ctx);
				if (refused) return refused;
			}
			if (fileInput) {
				if (input.filter !== undefined) return errorResult("Native file monitors do not support filter.");
				if (!ctx.monitorRegistry)
					return errorResult("Native file monitors require a lifecycle-owned monitor registry.");
				try {
					const approvedParent = (input as Record<string | symbol, unknown>)[APPROVED_MONITOR_PARENT] as
						| string
						| undefined;
					const { id, monitorId } = await ctx.monitorRegistry.registerFile({
						description: input.description,
						path: input.path,
						event: input.event ?? "create",
						// A persistent watch has no deadline (`deadlineMs: null`); its timeout only bounds registration.
						timeoutMs: resolveTimeoutMs(input.persistent === true ? undefined : input.timeout_ms),
						persistent: input.persistent === true,
						deadlineMs: input.persistent === true ? null : Date.now() + resolveTimeoutMs(input.timeout_ms),
						cwd: execCtx?.cwd ?? ctx.cwd,
						...(approvedParent !== undefined ? { approvedParent } : {}),
						...(input.persistent === true ? { expiresAt: Date.now() + DURABLE_MONITOR_EXPIRY_MS } : {}),
					});
					ctx.manager.bindMonitorId(monitorId, id);
					// Same spec capture as the command branch: durability inputs live only here.
					const sessionKey = manifestSessionKey(ctx);
					await handMonitorSpec(sessionKey, {
						monitorId,
						spec: {
							kind: "file",
							description: input.description,
							path: input.path,
							event: input.event ?? "create",
							timeoutMs: resolveTimeoutMs(input.timeout_ms),
							cwd: execCtx?.cwd ?? ctx.cwd,
							persistent: input.persistent === true,
							...(approvedParent !== undefined ? { approvedParent } : {}),
						},
					});
					// A durable watch checkpoints the registry's own identity tuple straight away, so a
					// restart before the first change still has a baseline (digest included) to compare to.
					if (input.persistent === true) handFileCheckpoint(sessionKey, monitorId, ctx.monitorRegistry, id);
					return textResult(`Monitor started with ID: ${monitorId}`, {
						details: { monitor_id: monitorId, bash_id: id, monitor: true },
					});
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
			}
			if (!commandInput) return errorResult("monitor requires description and command or path to start a watcher.");
			return createMonitor(ctx, registry, input, execCtx);
		},
	};
}
