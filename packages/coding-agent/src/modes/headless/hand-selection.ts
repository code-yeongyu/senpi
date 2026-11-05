/**
 * Which hand runs a headless session's tools (R4; the DK2a engine half). A hand directory says which hands this engine
 * can reach, and the user's choice is recorded per session, so it survives a restart. A chosen hand runs every tool
 * call of that session through a remote ToolHost. A chosen hand that cannot run them makes the calls fail as error
 * results; nothing falls back to this process. Choosing `null` gives the session back its own ToolHost (the fused
 * path, untouched).
 */
import {
	type Agent,
	createReliableTransport,
	createRemoteToolHost,
	type HandPlacement,
	type ToolHost,
	type Transport,
} from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../../core/session-manager.ts";

export interface HandRow {
	readonly device: string;
	readonly label: string;
	readonly platform: string;
	/** Listed but with no carrier up: it can be shown, not chosen. */
	readonly reachable: boolean;
}

/**
 * Where hands come from: the device service in production, an in-process link in tests. `link` is called only for a
 * listed, reachable hand. The directory closes a link when its hand leaves, and the remote host then answers that
 * hand's calls with error results.
 */
export interface HandDirectory {
	readonly list: () => readonly HandRow[];
	readonly link: (device: string) => { readonly transport: Transport; readonly placement: HandPlacement };
}

/** The session-file entry that records a session's choice; `device: null` is local. */
export const HAND_SELECTION_ENTRY = "hand_selection";

export type HandRefusal = "hand_not_listed" | "hand_unreachable";

export interface HandSession {
	readonly agent: Pick<Agent, "toolHost">;
	readonly sessionManager: Pick<SessionManager, "appendCustomEntry" | "getEntries">;
}

export interface HandSelection {
	readonly hands: () => readonly HandRow[];
	/** The recorded hand of a session (by durable id), `null` when local. */
	readonly selected: (durableSessionId: string) => string | null;
	readonly select: (
		durableSessionId: string,
		session: HandSession,
		device: string | null,
	) => { readonly ok: true } | { readonly ok: false; readonly refusal: HandRefusal };
	/** Re-applies the choice a session file recorded; a hand that cannot be linked now fails the session's calls. */
	readonly restore: (durableSessionId: string, session: HandSession) => void;
}

interface Applied {
	readonly own: ToolHost | undefined;
	readonly device: string;
	readonly remote: { close(): void };
}

/** A remote host on a transport that never connects: each call it gets ends as "The hand is unreachable". */
function unreachableHost(): ToolHost & { close(): void } {
	const transport = createReliableTransport({
		clock: { now: () => Date.now(), setTimer: () => () => {} },
		onHandlerError: () => {},
	});
	transport.close();
	return createRemoteToolHost({ transport, placement: "cross-machine" });
}

function recordedDevice(session: HandSession): string | null {
	let device: string | null = null;
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== HAND_SELECTION_ENTRY) continue;
		const recorded: unknown = Reflect.get(Object(entry.data), "device");
		device = typeof recorded === "string" ? recorded : null;
	}
	return device;
}

export function createHandSelection(directory: HandDirectory): HandSelection {
	const applied = new Map<string, Applied>();

	const install = (
		durableSessionId: string,
		session: HandSession,
		device: string,
		remote: ToolHost & { close(): void },
	) => {
		const previous = applied.get(durableSessionId);
		previous?.remote.close();
		applied.set(durableSessionId, {
			own: previous === undefined ? session.agent.toolHost : previous.own,
			device,
			remote,
		});
		session.agent.toolHost = remote;
	};

	const linked = (device: string) => createRemoteToolHost(directory.link(device));

	return {
		hands: () => directory.list(),
		selected: (durableSessionId) => applied.get(durableSessionId)?.device ?? null,
		select: (durableSessionId, session, device) => {
			if (device === null) {
				const previous = applied.get(durableSessionId);
				if (previous !== undefined) {
					previous.remote.close();
					session.agent.toolHost = previous.own;
					applied.delete(durableSessionId);
				}
				session.sessionManager.appendCustomEntry(HAND_SELECTION_ENTRY, { device: null });
				return { ok: true };
			}
			const row = directory.list().find((hand) => hand.device === device);
			if (row === undefined) return { ok: false, refusal: "hand_not_listed" };
			if (!row.reachable) return { ok: false, refusal: "hand_unreachable" };
			install(durableSessionId, session, device, linked(device));
			session.sessionManager.appendCustomEntry(HAND_SELECTION_ENTRY, { device });
			return { ok: true };
		},
		restore: (durableSessionId, session) => {
			const device = recordedDevice(session);
			if (device === null) return;
			const row = directory.list().find((hand) => hand.device === device);
			install(durableSessionId, session, device, row?.reachable === true ? linked(device) : unreachableHost());
		},
	};
}
