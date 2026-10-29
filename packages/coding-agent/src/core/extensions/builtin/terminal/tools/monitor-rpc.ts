/**
 * The monitor tool's rpc branch: resolve the source (`type` is inferred from the one source field given),
 * parse the target, arm the watch and answer with every matched session as it is now, so nothing before
 * arming is missed and nothing before arming is injected as an event.
 */
import { getAgentDir } from "../../../../../config.ts";
import { defaultEvents, parseRpcTarget, type RpcEvents } from "../rpc-monitor-targets.ts";
import { DURABLE_MONITOR_EXPIRY_MS } from "../shared.ts";
import type { TerminalManifestRpcCheckpoint } from "../terminal-manifest-model.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { handMonitorSpec, handRpcCheckpoint, manifestSessionKey } from "./monitor-manifest-binding.ts";
import { compileFilter, type MonitorInput, resolveTimeoutMs } from "./monitor-schema.ts";

export type MonitorSource = "command" | "path" | "rpc";

/** Which source a create call names; an error when it names none, several, or contradicts `type`. */
export function monitorSourceOf(input: MonitorInput): MonitorSource | { readonly error: string } {
	const given: MonitorSource[] = [];
	if (typeof input.command === "string" && input.command.length > 0) given.push("command");
	if (typeof input.path === "string" && input.path.length > 0) given.push("path");
	if (typeof input.target === "string" && input.target.length > 0) given.push("rpc");
	if (given.length > 1) return { error: `monitor takes one source; this call names ${given.join(" and ")}.` };
	const inferred = given[0];
	if (input.type !== undefined && inferred !== undefined && input.type !== inferred)
		return {
			error: `monitor type "${input.type}" needs ${fieldOf(input.type)}, but this call gives ${fieldOf(inferred)}.`,
		};
	const source = input.type ?? inferred;
	if (source === undefined)
		return { error: "monitor requires description and command, path or target to start a watcher." };
	if (inferred === undefined)
		return {
			error: `monitor type "${source}" needs ${fieldOf(source)}; ${source === "rpc" ? 'pass target: "children", "all" or a session id.' : "pass it."}`,
		};
	return source;
}

function fieldOf(source: MonitorSource): string {
	return source === "command" ? "command" : source === "path" ? "path" : "target";
}

export async function createRpcMonitor(ctx: TerminalToolContext, input: MonitorInput): Promise<TerminalToolResult> {
	const registry = ctx.monitorRegistry;
	if (registry === undefined) return errorResult("Rpc monitors require a lifecycle-owned monitor registry.");
	const description = input.description;
	if (description === undefined || description.length === 0)
		return errorResult("monitor requires description to start a watcher.");
	let filter: RegExp | undefined;
	try {
		filter = compileFilter(input.filter);
	} catch {
		return errorResult(`Invalid monitor filter regex: ${input.filter}`);
	}
	const sessionKey = manifestSessionKey(ctx);
	const target = parseRpcTarget(input.target ?? "", sessionKey);
	if ("error" in target) return errorResult(target.error);
	const events: RpcEvents | undefined = input.events;
	const persistent = input.persistent === true;
	const timeoutMs = persistent ? undefined : resolveTimeoutMs(input.timeout_ms);
	const { id, monitorId, rows } = await registry.registerRpc({
		description,
		target,
		targetText: input.target ?? "",
		events: events ?? defaultEvents(target),
		exclude: input.exclude ?? [],
		...(filter === undefined ? {} : { filter }),
		persistent,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(persistent ? { expiresAt: Date.now() + DURABLE_MONITOR_EXPIRY_MS } : {}),
		agentDir: getAgentDir(),
		...(persistent
			? {
					onCheckpoint: (monitorId: string, checkpoint: TerminalManifestRpcCheckpoint) =>
						handRpcCheckpoint(sessionKey, monitorId, checkpoint),
				}
			: {}),
	});
	ctx.manager.bindMonitorId(monitorId, id);
	await handMonitorSpec(sessionKey, {
		monitorId,
		spec: {
			kind: "rpc",
			description,
			target: input.target ?? "",
			...(events === undefined ? {} : { events }),
			...(input.exclude === undefined ? {} : { exclude: input.exclude }),
			filter: input.filter,
			persistent,
		},
		...(timeoutMs === undefined ? {} : { deadlineMs: Date.now() + timeoutMs }),
	});
	const listing = rows.length === 0 ? "No matching sessions yet." : `Watching:\n${rows.join("\n")}`;
	return textResult(`Monitor started with ID: ${monitorId}\n${listing}`, {
		details: { monitor_id: monitorId, bash_id: id, monitor: true },
	});
}
