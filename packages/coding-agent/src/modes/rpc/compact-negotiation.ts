import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcConnectionOptions } from "./connection-handler.ts";
import { CONNECTION_ROLE_FIXED } from "./connection-roles.ts";
import type { RpcCommand } from "./rpc-types.ts";
import { COMPACT_EVENTS_CAPABILITY } from "./custom-capability.ts";
import { EVENT_RESYNC_CAPABILITY } from "./socket-peer-recovery.ts";
export const COMPACT_UPDATES_CAPABILITY = "compact_message_updates_v1";
export const COMPACT_PAIR = [COMPACT_UPDATES_CAPABILITY, EVENT_RESYNC_CAPABILITY] as const;

/** A declaration belongs to one actual socket registration, never a session or launch profile. */
export class CompactSelection {
	capabilities: readonly string[] = [];
	selected = false;
	admitted = false;
	refused = false;
	declare(
		next: readonly string[] | undefined,
		supported: boolean,
		roles: (caps: readonly string[]) => boolean,
	): string | undefined {
		if (this.refused) return "compact_selection_refused";
		const caps = next ?? this.capabilities;
		const compact = compactUpdatesEnabled() && caps.includes(COMPACT_UPDATES_CAPABILITY);
		const pair = compact && caps.includes(EVENT_RESYNC_CAPABILITY);
		const refusal =
			compact && !pair
				? "compact_pair_required"
				: compact && !supported
					? "compact_endpoint_unsupported"
					: this.selected && !pair
						? "compact_selection_fixed"
						: this.admitted && pair !== this.selected
							? "compact_selection_fixed"
							: undefined;
		if (refusal) {
			if (!this.selected && compact && !this.admitted) this.refused = true;
			return refusal;
		}
		if (next !== undefined && !roles(caps)) {
			if (compact && !this.selected && !this.admitted) this.refused = true;
			return "connection_role_fixed";
		}
		this.capabilities = caps.filter(
			(cap) => cap !== COMPACT_EVENTS_CAPABILITY && (compactUpdatesEnabled() || cap !== COMPACT_UPDATES_CAPABILITY),
		);
		this.selected = pair;
		return undefined;
	}
	wireCapabilities(caps: readonly string[], enabled: boolean): readonly string[] {
		return !enabled
			? caps.filter((cap) => cap !== COMPACT_EVENTS_CAPABILITY)
			: this.selected
				? [...caps, COMPACT_EVENTS_CAPABILITY]
				: caps;
	}
	ack() {
		return this.selected ? { capabilities: [...COMPACT_PAIR] } : undefined;
	}
}

/** Unknown/inherited opt-ins cannot stand in for an actual endpoint implementation. */
export function advertisedCompactCapabilities(caps: readonly string[], supported: boolean): string[] {
	const legacy = caps.filter((cap) => cap !== COMPACT_UPDATES_CAPABILITY && cap !== COMPACT_EVENTS_CAPABILITY);
	return compactUpdatesEnabled() && supported ? [...new Set([...legacy, ...COMPACT_PAIR])] : legacy;
}

export function declarationReply(record: object, selection: CompactSelection | undefined): object | undefined {
	const response = record as { type?: string; command?: string; success?: boolean; id?: string };
	if (response.type !== "response" || response.command !== "set_client_info") return record;
	if (response.id === undefined) return undefined;
	return response.success && selection?.selected ? { ...record, data: selection.ack() } : record;
}
/** Shared handler applies session flags only after host validation; classic handlers never select compact. */
export function sessionDeclaration(
	options: RpcConnectionOptions,
	command: Extract<RpcCommand, { type: "set_client_info" }>,
	current: readonly string[] | undefined,
	declare: (caps: string[]) => boolean,
	replace: (caps: string[]) => void,
) {
	const caps = command.capabilities;
	if (caps !== undefined) {
		if (!options.clientInfo && compactUpdatesEnabled() && caps.includes(COMPACT_UPDATES_CAPABILITY))
			return { capabilities: current, refusal: "compact_endpoint_unsupported" };
		if (!declare(caps)) return { capabilities: current, refusal: CONNECTION_ROLE_FIXED };
		if (!options.clientInfo) replace(caps);
		else options.clientInfo.setCapabilities(options.clientInfo.connectionId(), caps);
	}
	return {
		capabilities: caps ?? current,
		refusal: undefined,
		grantChanged:
			(current?.includes("grant_select") === true) !== ((caps ?? current)?.includes("grant_select") === true),
	};
}
