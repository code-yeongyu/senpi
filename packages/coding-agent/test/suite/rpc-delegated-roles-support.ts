/** Shared steps of the omo-relay-daemon#307 host-scope suites: sessions, role-bound peers, holds and dialogs. */
import { expect } from "vitest";
import {
	ASK_COMMAND,
	attach,
	type DelegatedHost,
	declare,
	type OpenedSession,
	openSession,
	type Peer,
	type WireRecord,
} from "./rpc-delegated-host-support.ts";

export const GRANT = ["observe", "drive", "thread"];
export const BOTH = ["interactive_user", "task_parent"];
export const VIEWER = { deviceId: "x307-device", deviceName: "Viewer" };
export const NOT_INTERACTIVE = "hold_input_requires_interactive_client";

export function rolesFixture(host: () => DelegatedHost, opener: () => Peer) {
	const opened = new Map<string, OpenedSession>();
	let inputs = 0;
	const fixture = {
		async openSession(): Promise<string> {
			const session = await openSession(opener());
			opened.set(session.sessionId, session);
			return session.sessionId;
		},
		attachTo(sessionId: string): WireRecord {
			const session = opened.get(sessionId);
			if (session === undefined) throw new Error(`no session ${sessionId}`);
			return attach(session);
		},
		/** A role-bound peer attached to a fresh session, holding `claim` (none when empty). */
		async hostPeer(claim: readonly string[] = ["interactive_user"], granted = GRANT, principal: object = VIEWER) {
			const peer = await host().proven();
			expect(await declare(peer, granted, principal, { roles: BOTH })).toMatchObject({ success: true });
			const sessionId = await fixture.openSession();
			expect(await peer.send(fixture.attachTo(sessionId))).toMatchObject({ success: true });
			if (claim.length > 0)
				expect(await peer.send({ type: "set_client_info", capabilities: claim })).toMatchObject({ success: true });
			return { peer, sessionId };
		},
		hold(sessionId: string, extra: WireRecord = {}): WireRecord {
			return { type: "hold_input", sessionId, inputId: `x307-${++inputs}`, revision: 0, text: "guidance", ...extra };
		},
		/** The `remoteOrigin` of the dialog the peer's own command raises; the dialog is cancelled afterwards. */
		async dialogOrigin(peer: Peer, sessionId: string): Promise<unknown> {
			const asked = peer.frame(
				(record) =>
					record.type === "extension_ui_request" && record.sessionId === sessionId && record.title === "Question",
			);
			void peer.send({ type: "prompt", sessionId, message: `/${ASK_COMMAND}` }).catch(() => {});
			const request = await asked;
			await peer.sendSettled({ type: "extension_ui_response", sessionId, uiRequestId: request.id, cancelled: true });
			return request.remoteOrigin;
		},
	};
	return fixture;
}
