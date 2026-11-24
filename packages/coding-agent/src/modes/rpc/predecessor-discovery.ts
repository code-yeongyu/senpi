import { join } from "node:path";
import { readJsonObject } from "./host-state-json.ts";
import { readHandoverParkedSessions } from "./host-handover-parked.ts";
import { readSessionPathClaims } from "./host-reservations.ts";
import { hostGeneration } from "./protocol-identity.ts";
import {
	PredecessorPeer,
	RouteDisconnected,
	type RouteEndpoint,
	RouteTimedOut,
	routeEndpointGone,
} from "./predecessor-peer.ts";
import type { RouteTable } from "./predecessor-route-table.ts";
import { isRoutedSessionRow } from "./predecessor-wire.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import { SOCKET_HANDSHAKE_TIMEOUT_MS } from "./socket-transport.ts";

/** How long a listing waits for a predecessor's answer: as long as its handshake may take. */
export const PREDECESSOR_DISCOVERY_TIMEOUT_MS = SOCKET_HANDSHAKE_TIMEOUT_MS;

/**
 * Discovery is read-only: no route peer used for a list counts as an attachment or opens a runtime. A predecessor
 * that cannot answer (it exited mid-request, as a drain ends, or it stalled) contributes no rows; it never fails
 * the successor's own listing (senpi#7098).
 */
export async function discoverRoutes(table: RouteTable): Promise<void> {
	const host = table.host;
	const dir = host.handoverParkedDir;
	const keyRoot = host.defaults.agentDir;
	const self = host.defaults.hostContext?.host_instance;
	if (
		!dir ||
		!keyRoot ||
		!self ||
		host.draining ||
		!hostGeneration(process.env) ||
		(!host.inheritedHandover?.predecessorDraining && !table.byId.size)
	)
		return;
	if ((await readJsonObject(join(dir, "host.pid")))?.instance_id !== self) return;
	const owners = new Map<string, Set<string>>();
	for (const { owner } of await readSessionPathClaims(join(dir, "reservations"))) {
		if (owner.instanceId === self || !owner.strict_transfer || !/^[a-zA-Z0-9_-]+$/.test(owner.instanceId)) continue;
		const paths = owners.get(owner.instanceId) ?? new Set();
		paths.add(owner.sessionPath);
		owners.set(owner.instanceId, paths);
	}
	await Promise.all(
		[...owners].map(async ([instanceId, paths]) => {
			const file = await readJsonObject(join(dir, "generations", instanceId, "route.json"));
			if (typeof file?.socket !== "string" || typeof file.launchId !== "string") return;
			await listPredecessor(table, { socket: file.socket, launchId: file.launchId, instanceId, keyRoot }, paths);
		}),
	);
	const unclaimed = [...table.byId.values()].filter(
		(r) => !owners.get(r.endpoint.instanceId)?.has(r.path) && !r.attachments.size && !r.switching,
	);
	if (unclaimed.length) {
		const parked = new Set(
			(await readHandoverParkedSessions(dir)).map((entry) => canonicalSessionPath(entry.sessionPath)),
		);
		for (const route of unclaimed)
			if (!parked.has(route.path) && !route.attachments.size && table.holds(route)) table.forget(route);
	}
}

async function listPredecessor(table: RouteTable, endpoint: RouteEndpoint, paths: ReadonlySet<string>): Promise<void> {
	let peer: PredecessorPeer | undefined;
	try {
		peer = await PredecessorPeer.connect(
			endpoint,
			() => {},
			() => {},
		);
		const answer = await peer.request(
			{ type: "list_sessions", include_workers: true },
			PREDECESSOR_DISCOVERY_TIMEOUT_MS,
		);
		const rows = authRecord(answer.data)?.sessions;
		if (!Array.isArray(rows)) return;
		const localPaths = new Set(
			table.host.registry.list().flatMap((row) => (row.sessionPath ? [canonicalSessionPath(row.sessionPath)] : [])),
		);
		for (const row of rows) {
			if (!isRoutedSessionRow(row) || !row.sessionPath || row.status !== "open") continue;
			const path = canonicalSessionPath(row.sessionPath);
			if (!paths.has(path) || localPaths.has(path)) continue;
			const route = table.route(path, endpoint);
			route.upstream = row.sessionId;
			route.row = row;
			route.generation = peer.generation;
		}
	} catch (cause) {
		// Socket unlink, child exit and a stall all race the list: none of them is this listing's failure.
		if (unanswered(cause)) return;
		// A bad proof is not proof of exit: nothing is routed through it, and the refusal stays on record.
		process.stderr.write(
			`senpi rpc: predecessor ${endpoint.instanceId} gave no session list: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
	} finally {
		peer?.close();
	}
}

function unanswered(cause: unknown): boolean {
	return cause instanceof RouteDisconnected || cause instanceof RouteTimedOut || routeEndpointGone(cause);
}
