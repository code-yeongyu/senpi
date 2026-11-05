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
 * listed, reachable hand, once per session that chooses it, and returns a transport of its own for that session: the
 * selection closes it when the session leaves the hand or ends, which never touches another session on the same hand.
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
	/**
	 * Starts tracking a session that just opened and re-applies the choice its file recorded; a hand that cannot be
	 * linked now fails the session's calls. Nothing from an earlier runtime of the same id is kept.
	 */
	readonly restore: (durableSessionId: string, session: HandSession) => void;
	/** Forgets a session that ended and closes its link to the hand. */
	readonly release: (durableSessionId: string) => void;
}

interface SessionHands {
	/** The ToolHost the session had before any choice; `null` gives it back. */
	readonly own: ToolHost | undefined;
	readonly device: string | null;
	readonly remote: { close(): void } | undefined;
	/** Whether `remote` is a live link to `device`, not the placeholder for a hand that could not be linked. */
	readonly linked: boolean;
}

interface Remote {
	readonly host: ToolHost & { close(): void };
	readonly linked: boolean;
}

export interface HandSelectionOptions {
	/** Wraps every host the selection installs (the presence gate on a headless engine with presence). */
	readonly gate?: (durableSessionId: string, host: ToolHost) => ToolHost;
	/** Called after a session's hand changes, with the device or `null` for local. */
	readonly onChange?: (durableSessionId: string, device: string | null) => void;
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

export function createHandSelection(directory: HandDirectory, options: HandSelectionOptions = {}): HandSelection {
	const sessions = new Map<string, SessionHands>();
	const gate = options.gate ?? ((_id: string, host: ToolHost) => host);

	const stateOf = (durableSessionId: string, session: HandSession): SessionHands => {
		const known = sessions.get(durableSessionId);
		if (known !== undefined) return known;
		const fresh = { own: session.agent.toolHost, device: null, remote: undefined, linked: false };
		sessions.set(durableSessionId, fresh);
		return fresh;
	};

	const install = (
		durableSessionId: string,
		session: HandSession,
		device: string | null,
		remote: Remote | undefined,
	) => {
		const state = stateOf(durableSessionId, session);
		state.remote?.close();
		sessions.set(durableSessionId, { own: state.own, device, remote: remote?.host, linked: remote?.linked ?? false });
		session.agent.toolHost = remote === undefined ? state.own : gate(durableSessionId, remote.host);
		options.onChange?.(durableSessionId, device);
	};

	const unreachable = (): Remote => ({ host: unreachableHost(), linked: false });
	const linkTo = (device: string): Remote => {
		try {
			return { host: createRemoteToolHost(directory.link(device)), linked: true };
		} catch {
			return unreachable();
		}
	};

	return {
		hands: () => directory.list(),
		selected: (durableSessionId) => sessions.get(durableSessionId)?.device ?? null,
		select: (durableSessionId, session, device) => {
			const current = stateOf(durableSessionId, session);
			// Already on it: nothing to do. A recorded hand that was not linked (gone at reopen) is linked again below.
			if (current.device === device && (device === null || current.linked)) return { ok: true };
			if (device !== null) {
				const row = directory.list().find((hand) => hand.device === device);
				if (row === undefined) return { ok: false, refusal: "hand_not_listed" };
				if (!row.reachable) return { ok: false, refusal: "hand_unreachable" };
			}
			// Recorded first: a failed write leaves the session as it was.
			if (current.device !== device) session.sessionManager.appendCustomEntry(HAND_SELECTION_ENTRY, { device });
			install(durableSessionId, session, device, device === null ? undefined : linkTo(device));
			return { ok: true };
		},
		restore: (durableSessionId, session) => {
			sessions.get(durableSessionId)?.remote?.close();
			sessions.delete(durableSessionId);
			stateOf(durableSessionId, session);
			const device = recordedDevice(session);
			if (device === null) return;
			const row = directory.list().find((hand) => hand.device === device);
			install(durableSessionId, session, device, row?.reachable === true ? linkTo(device) : unreachable());
		},
		release: (durableSessionId) => {
			sessions.get(durableSessionId)?.remote?.close();
			sessions.delete(durableSessionId);
		},
	};
}
