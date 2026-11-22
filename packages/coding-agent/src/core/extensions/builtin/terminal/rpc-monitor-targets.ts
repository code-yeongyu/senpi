/**
 * What an rpc monitor watches and how it asks for it. `children` matches the sessions whose lineage names
 * this session (the host evaluates `childrenOf`, so children spawned after arming match too), `all` every
 * session of every endpoint the user runs (hosts and terminals alike: one OS user, one ownership
 * boundary), and any other target one session by routing id, durable id, path, or a `st_` task id read
 * from its published context. Content kinds are asked for with `mirror` on every target, which never
 * makes the observer an attachment.
 */
import { listHostEndpoints } from "../../../../modes/rpc/host-endpoints.ts";
import type { RpcRecord } from "./rpc-monitor-observer.ts";
import { currentRpcRemoteSource } from "./rpc-remote-source.ts";

export type RpcTarget =
	| { readonly kind: "children"; readonly parent: string }
	| { readonly kind: "all" }
	| { readonly kind: "id"; readonly id: string }
	| { readonly kind: "task"; readonly taskId: string }
	| { readonly kind: "remote"; readonly device: string; readonly session: string };

// `<device>/<session>` or `<device>/*`: one `/`, no leading `/`, not a `.jsonl` path, not a drive letter.
const REMOTE_TARGET = /^(?<device>[^/]+)\/(?<session>[^/]+)$/;
const DRIVE_LETTER = /^[A-Za-z]:$/;

export type RpcEvents = "all" | readonly string[];

const STATUS_KINDS = new Set(["session_status", "effect_status"]);

export function parseRpcTarget(
	target: string,
	selfDurableId: string | undefined,
): RpcTarget | { readonly error: string } {
	const trimmed = target.trim();
	if (trimmed === "") return { error: 'target is empty; pass "children", "all" or a session id, path or st_ task id' };
	if (trimmed === "children") {
		if (selfDurableId === undefined)
			return {
				error: 'target "children" needs a session with a durable id; save the session first, or watch "all"',
			};
		return { kind: "children", parent: selfDurableId };
	}
	if (trimmed === "all") return { kind: "all" };
	if (trimmed.startsWith("st_")) return { kind: "task", taskId: trimmed };
	const remote = REMOTE_TARGET.exec(trimmed)?.groups;
	if (remote?.device !== undefined && remote.session !== undefined && isRemoteShape(trimmed, remote.device)) {
		if (currentRpcRemoteSource() === undefined)
			return {
				error: `target "${trimmed}" names a session on another device; remote targets need the omo remote surface`,
			};
		return { kind: "remote", device: remote.device, session: remote.session };
	}
	return { kind: "id", id: trimmed };
}

function isRemoteShape(target: string, device: string): boolean {
	return !target.endsWith(".jsonl") && !DRIVE_LETTER.test(device);
}

/** `["session_status", "effect_status"]` for children, `["session_status"]` otherwise. */
export function defaultEvents(target: RpcTarget): readonly string[] {
	return target.kind === "children" ? ["session_status", "effect_status"] : ["session_status"];
}

/** The `subscribe_sessions` frame (without id/type) for one endpoint. */
export function subscriptionFor(target: RpcTarget, events: RpcEvents): RpcRecord {
	const sessions =
		target.kind === "children" ? { childrenOf: target.parent } : target.kind === "id" ? { ids: [target.id] } : "all";
	const content = events === "all" ? "all" : events.filter((kind) => !STATUS_KINDS.has(kind));
	const mirror = content === "all" ? "all" : content.length === 0 ? undefined : content;
	return {
		sessions,
		include_workers: true,
		include_context: target.kind === "children" || target.kind === "task",
		effects: events === "all" || events.includes("effect_status"),
		...(mirror === undefined ? {} : { mirror }),
	};
}

/** Whether a delivered record is one the monitor reports. */
export function wantsRecord(events: RpcEvents, exclude: readonly string[], type: string): boolean {
	if (exclude.includes(type)) return false;
	return events === "all" || events.includes(type);
}

/** For a `st_` target: whether a record or snapshot row belongs to that task. */
export function matchesTask(target: RpcTarget, row: RpcRecord): boolean {
	if (target.kind !== "task") return true;
	const context = row.context as Record<string, unknown> | undefined;
	return context?.task_id === target.taskId;
}

/** Every endpoint socket the user runs under this agent dir (hosts and terminal endpoints). */
export async function endpointSockets(agentDir: string): Promise<readonly string[]> {
	return (await listHostEndpoints(agentDir))
		.map((endpoint) => endpoint.socket)
		.filter((socket): socket is string => socket !== null);
}
