/**
 * The seam an extension uses to serve rpc watches on another device's sessions (`<device>/<session>`,
 * `<device>/*`). senpi knows no relay: it hands the source the target and four callbacks, renders what
 * comes back with the local renderer, and keeps the source's resume position in the monitor checkpoint.
 * This module is light on purpose: target parsing reads it on every arm, local or not.
 */
import type { RpcRecord } from "./rpc-monitor-observer.ts";
import type { RpcEvents } from "./rpc-monitor-targets.ts";

/** A device id or label from the account roster, and a session id or alias on it; `"*"` is every session. */
export interface RpcRemoteTarget {
	readonly device: string;
	readonly session: string;
}

/** A turn that settled, named by the `turnId` its `agent_settled` carries. */
export interface RpcRemoteSettledTurn {
	readonly sessionId: string;
	readonly turnId: string;
}

/** The watched sessions as they are now, and what settled since the source's last position. */
export interface RpcRemoteState {
	/** One row per session, shaped like a local subscription snapshot row (`sessionId`, `status`, ...). */
	readonly rows: readonly RpcRecord[];
	/** Turns that settled since the resume position; turns the watch already reported are skipped. */
	readonly settledTurns?: readonly RpcRemoteSettledTurn[];
	/** The remote engine's identity; a change reads as that host restarting. */
	readonly generation?: string;
	/** Where the source would resume after a caller restart: opaque to senpi, saved as written. */
	readonly cursor?: string;
}

export interface RpcRemoteHandlers {
	/** One live record, shaped like a local rpc record (`type`, `sessionId`, ...). */
	record(record: RpcRecord): void;
	/** The source re-synced after a gap (reconnect, re-attach, engine restart): the state now. */
	resynced(state: RpcRemoteState): void;
	cursor(cursor: string): void;
	/** The device stopped answering; the source keeps trying and resyncs when it is back. */
	lost(reason: string): void;
	/** The watch can never continue (access revoked, plan ended): the monitor settles. */
	ended(reason: string): void;
}

export interface RpcRemoteOpenOptions {
	readonly events: RpcEvents;
	readonly exclude: readonly string[];
	/** The cursor a restored watch saved; absent on a fresh arm. */
	readonly resumeFrom?: string;
}

export interface RpcRemoteSubscription {
	/** The state at open: its rows are the arm-time listing. */
	readonly initial: RpcRemoteState;
	stop(): void;
}

export interface RpcRemoteSource {
	/** Resolves once the target is watched; rejects with a typed reason when it cannot be. */
	open(
		target: RpcRemoteTarget,
		options: RpcRemoteOpenOptions,
		handlers: RpcRemoteHandlers,
	): Promise<RpcRemoteSubscription>;
}

const sources: Array<{ readonly source: RpcRemoteSource }> = [];

/** Registers the source remote targets use; the latest registration wins. Returns its unregister. */
export function registerRpcRemoteSource(source: RpcRemoteSource): () => void {
	const entry = { source };
	sources.push(entry);
	return () => {
		const index = sources.indexOf(entry);
		if (index !== -1) sources.splice(index, 1);
	};
}

export function currentRpcRemoteSource(): RpcRemoteSource | undefined {
	return sources.at(-1)?.source;
}
