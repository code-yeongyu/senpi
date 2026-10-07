/**
 * The readiness gate of a host this process just spawned: poll `get_protocol_info` until the host
 * answers compatibly, the budget runs out, or the spawned supervisor exits. A compatible answer
 * comes with the attach hold of the connection it arrived on (see host-attach-hold.ts).
 */

import type { HostAttachHold } from "./host-attach-hold.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import { holdProtocolInfo } from "./host-probe.ts";

export type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type ProtocolPollResult =
	| { readonly ready: true; readonly protocol: HostProtocolInfo; readonly hold: HostAttachHold }
	| { readonly ready: false; readonly protocol?: HostProtocolInfo; readonly exited?: ChildExit };

const SPAWNED_HOST_PROBE_TIMEOUT_MS = 10_000;

export async function pollProtocolInfo(
	socket: string,
	timeoutMs: number,
	isCompatible: (protocol: HostProtocolInfo | undefined) => boolean,
	childExit?: Promise<ChildExit>,
): Promise<ProtocolPollResult> {
	const deadline = Date.now() + timeoutMs;
	let lastProtocol: HostProtocolInfo | undefined;
	while (Date.now() <= deadline) {
		const probe = holdProtocolInfo(
			socket,
			Math.min(SPAWNED_HOST_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
		);
		const raced = childExit ? await Promise.race([probe, childExit]) : await probe;
		if (isChildExit(raced)) {
			// A supervisor exit can be triggered by the Windows identity watchdog
			// while a named-pipe client is still composing its protocol reply. Do
			// not terminate the host based solely on that exit until this probe has
			// had a chance to deliver an answer. A host that never answers still
			// resolves through holdProtocolInfo's bounded timeout/close handling.
			const held = await probe;
			if (!held) return { ready: false, protocol: lastProtocol, exited: raced };
			lastProtocol = held.info;
			if (isCompatible(held.info)) return { ready: true, protocol: held.info, hold: held.hold };
			held.hold.release();
		} else if (raced) {
			lastProtocol = raced.info;
			if (isCompatible(raced.info)) return { ready: true, protocol: raced.info, hold: raced.hold };
			raced.hold.release();
		}
		await delay(50);
	}
	return { ready: false, protocol: lastProtocol };
}

function isChildExit(value: { readonly info: HostProtocolInfo } | ChildExit | undefined): value is ChildExit {
	return !!value && "code" in value && "signal" in value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
