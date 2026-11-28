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
import type { PromptSurface } from "../../core/dynamic-prompt/build.ts";
import { withHandPageBudget } from "../../extensions/html-render/hand-page-budget.ts";
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

/**
 * `persona_not_supported_on_hand`: the session was opened with `open_session.persona`, which its own runtime applies, but a
 * hand runs every call (and every nested call its tools make) on a runtime of its own that never receives it (omo#13057).
 */
export type HandRefusal = "hand_not_listed" | "hand_unreachable" | "session_busy" | "persona_not_supported_on_hand";

export interface HandSession {
	readonly agent: Pick<Agent, "toolHost" | "subscribe">;
	/** A run copies its ToolHost when it starts, so the choice changes only between runs. */
	readonly isStreaming: boolean;
	readonly sessionManager: Pick<SessionManager, "appendCustomEntry" | "getEntries">;
	/** Sent with each call to the hand, so a tool there reports what this session's host does (senpi#6921). */
	readonly promptSurface: PromptSurface;
	/** Sent with each call too, so show_html_page on the hand says whether this session's client showed the page. */
	readonly rendersHtmlInline: boolean;
}

export interface HandSelection {
	readonly hands: () => readonly HandRow[];
	/** The recorded hand of a session (by durable id), `null` when local. */
	readonly selected: (durableSessionId: string) => string | null;
	/** `personaBound`: the session's launch profile carries a persona, so no hand may run its calls. */
	readonly select: (
		durableSessionId: string,
		session: HandSession,
		device: string | null,
		personaBound?: boolean,
	) => { readonly ok: true } | { readonly ok: false; readonly refusal: HandRefusal };
	/**
	 * Starts tracking a session that just opened and re-applies the choice its file recorded; a hand that cannot be
	 * linked now fails the session's calls. Nothing from an earlier runtime of the same id is kept.
	 */
	readonly restore: (durableSessionId: string, session: HandSession, personaBound?: boolean) => void;
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
	/** Called when a session ends and its hand state is forgotten. */
	readonly onRelease?: (durableSessionId: string) => void;
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
		// The hand cannot see this session's transcript, so the session's page budget is applied here (senpi#6921). The
		// budget is what the session keeps and closes, so it stops listening for the session's runs with the link (senpi#6932).
		const host = remote === undefined ? undefined : withHandPageBudget(remote.host, session);
		sessions.set(durableSessionId, { own: state.own, device, remote: host, linked: remote?.linked ?? false });
		session.agent.toolHost = host === undefined ? state.own : gate(durableSessionId, host);
		options.onChange?.(durableSessionId, device);
	};

	const unreachable = (): Remote => ({ host: unreachableHost(), linked: false });
	const linkTo = (device: string, session: HandSession): Remote => {
		try {
			return {
				host: createRemoteToolHost({
					...directory.link(device),
					promptSurface: () => session.promptSurface,
					inlineHtml: () => session.rendersHtmlInline,
				}),
				linked: true,
			};
		} catch {
			return unreachable();
		}
	};

	return {
		hands: () => directory.list(),
		selected: (durableSessionId) => sessions.get(durableSessionId)?.device ?? null,
		select: (durableSessionId, session, device, personaBound) => {
			if (device !== null && personaBound === true) return { ok: false, refusal: "persona_not_supported_on_hand" };
			const current = stateOf(durableSessionId, session);
			// Already on it: nothing to do. A recorded hand that was not linked (gone at reopen) is linked again below.
			if (current.device === device && (device === null || current.linked)) return { ok: true };
			// A running turn keeps the ToolHost it started with: a change now would leave its later batches on the old one.
			if (session.isStreaming) return { ok: false, refusal: "session_busy" };
			let remote: Remote | undefined;
			if (device !== null) {
				const row = directory.list().find((hand) => hand.device === device);
				if (row === undefined) return { ok: false, refusal: "hand_not_listed" };
				if (!row.reachable) return { ok: false, refusal: "hand_unreachable" };
				remote = linkTo(device, session);
				if (!remote.linked) {
					remote.host.close();
					return { ok: false, refusal: "hand_unreachable" };
				}
			}
			// Recorded before it is installed: a failed write leaves the session as it was.
			try {
				if (current.device !== device) session.sessionManager.appendCustomEntry(HAND_SELECTION_ENTRY, { device });
			} catch (cause) {
				remote?.host.close();
				throw cause;
			}
			install(durableSessionId, session, device, remote);
			return { ok: true };
		},
		restore: (durableSessionId, session, personaBound) => {
			sessions.get(durableSessionId)?.remote?.close();
			sessions.delete(durableSessionId);
			stateOf(durableSessionId, session);
			const device = recordedDevice(session);
			if (device === null) return;
			const row = directory.list().find((hand) => hand.device === device);
			// A persona session reopened on a file that recorded a hand never runs there: its calls fail visibly instead of
			// running on a runtime without its tool policy, or silently moving to this machine (omo#13057).
			const linkable = row?.reachable === true && personaBound !== true;
			install(durableSessionId, session, device, linkable ? linkTo(device, session) : unreachable());
		},
		release: (durableSessionId) => {
			sessions.get(durableSessionId)?.remote?.close();
			sessions.delete(durableSessionId);
			options.onRelease?.(durableSessionId);
		},
	};
}
