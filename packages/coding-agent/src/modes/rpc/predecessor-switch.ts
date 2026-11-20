/**
 * Moving a routed session onto this generation once its predecessor parks it, or once the route to it broke.
 *
 * Every waiter is bounded: it waits for the switch at most the close grace window and then answers a retryable
 * refusal, and every way the recovery ends settles the route, so nothing waits on a switch nobody finishes.
 */
import { stat } from "node:fs/promises";
import { readHandoverParkedSessions } from "./host-handover-parked.ts";
import type { Route, RouteTable } from "./predecessor-route-table.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";

const SWITCH_RETRY_MS = 250;
/** Answered to a command whose switch has not finished within the close grace window: retry it. */
export const SWITCH_PENDING = "generation_switch_pending";

export class RouteSwitchFailed extends Error {}

export type SwitchOutcome =
	| { readonly kind: "switched" }
	| { readonly kind: "pending" }
	| { readonly kind: "failed"; readonly code: string };

export function switchRoute(table: RouteTable, route: Route): void {
	if (route.switching || !table.holds(route)) return;
	route.switching = true;
	// The regular watch can win this race. It and this recovery path take the same registry
	// claim and attach to the same in-flight open; a broken socket never grants a write lease.
	void recover(table, route).then(
		(code) => settle(table, route, code),
		(cause: unknown) => settle(table, route, cause instanceof Error ? cause.message : String(cause)),
	);
}

/** Undefined once the session is local (or no longer routed); otherwise the code its waiters are refused with. */
async function recover(table: RouteTable, route: Route): Promise<string | undefined> {
	while (table.holds(route)) {
		if (table.host.draining) return "host_draining";
		const dir = table.host.handoverParkedDir;
		if (!table.reopen || !dir) return "generation_route_gone";
		const records = await readHandoverParkedSessions(dir);
		const entry = records.find((r) => r.sessionPath === route.path && r.parkedBy === route.endpoint.instanceId) ??
			route.park ?? {
				sessionPath: route.path,
				durableSessionId: route.row?.durableSessionId,
				retainOnDisconnect: route.row?.retain_on_disconnect === true,
				cwd: route.row?.cwd,
			};
		if (!table.holds(route)) return undefined;
		const isFile = await stat(entry.sessionPath).then(
			(file) => file.isFile(),
			() => false,
		);
		if (!isFile) return "session_file_gone";
		const result = await table.reopen({ ...entry, live: true });
		if (result?.success) return undefined;
		if (!result) return "generation_route_gone";
		// A killed predecessor's claim and holder record both stand until its process is gone and reaped.
		if (result.error !== "session_path_in_use" && result.error !== "session_held") return result.error;
		await new Promise((resolve) => setTimeout(resolve, SWITCH_RETRY_MS));
	}
	return undefined;
}

function settle(table: RouteTable, route: Route, code: string | undefined): void {
	if (code !== undefined) route.local.reject(new RouteSwitchFailed(code));
	if (table.holds(route)) table.forget(route);
}

export async function awaitSwitch(table: RouteTable, route: Route): Promise<SwitchOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Promise<SwitchOutcome>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "pending" }), table.host.registry.closeGraceMs);
	});
	try {
		return await Promise.race([
			route.local.promise.then(
				(): SwitchOutcome => ({ kind: "switched" }),
				(cause: unknown): SwitchOutcome => ({
					kind: "failed",
					code: cause instanceof Error ? cause.message : String(cause),
				}),
			),
			pending,
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function afterSwitch(
	table: RouteTable,
	route: Route,
	command: { readonly id?: string; readonly type: string },
	local: () => Promise<RpcResponse | undefined>,
): Promise<RpcResponse | undefined> {
	const outcome = await awaitSwitch(table, route);
	if (outcome.kind === "switched") return local();
	return error(command.id, command.type, outcome.kind === "pending" ? SWITCH_PENDING : outcome.code);
}
