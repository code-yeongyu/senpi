/**
 * The terminal's presenter host surface (senpi#4249, D11 2.9 S3-6b): its control connections become presenters on the
 * TUI's own `McpPresenterAuthority`, the one the terminal itself holds its `local_tui` grant on. A connection that
 * declared `interactive_user` + `mcp_form_presenter_v1` is connected, attached while it holds a live attachment, and
 * withdrawn when it loses a role; its private frames are answered on that connection only, as `mcp_form_reply`.
 *
 * Private records never pass through the terminal's record writer, its feed, an observer subscription, a session entry
 * or a ledger: they are written straight to the connection's own socket, as the RPC host's `handleMcpForm` does.
 */
import { rm } from "node:fs/promises";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import { serializeJsonLine } from "../rpc/jsonl.ts";
import type { PresenterAccountAuthority } from "../rpc/mcp-presenter-account.ts";
import type { McpPresenterAuthority, McpPresenterConnection } from "../rpc/mcp-presenter-authority.ts";
import { startMcpPresenterControl } from "../rpc/mcp-presenter-control-start.ts";
import { type PresenterHostSurface, presenterContextReply } from "../rpc/mcp-presenter-host-surface.ts";
import type { SessionEventWriterConnection } from "../rpc/session-event-connection.ts";
import type { SealedSecretSource } from "../rpc/secret-sealed-holders.ts";
import type { LocalMcpPresenter } from "./mcp-local-presenter.ts";
import { TerminalSealedSecrets } from "./terminal-sealed-secrets.ts";

export const TERMINAL_PRESENTER_COMMANDS = [
	"mcp_presenter_context",
	"mcp_form_presented",
	"mcp_form_response",
	"mcp_form_sync",
	"mcp_presenter_secret_answer",
] as const;

export interface TerminalMcpPresenter {
	readonly local: LocalMcpPresenter;
	/** Injected by the distribution at TUI start, never by a command: lets same-account devices enroll. */
	readonly account?: PresenterAccountAuthority;
}

/**
 * The terminal's presenter surface, and its control endpoint when an account authority is injected: a terminal has no
 * fd-4 path, so every other presenter on it is an account principal. A failed start leaves the surface without one.
 */
export async function startTerminalPresenters(
	presenter: TerminalMcpPresenter,
): Promise<{ readonly surface: TerminalPresenterSurface; readonly dispose: () => Promise<void> }> {
	const surface = new TerminalPresenterSurface(presenter.local);
	const started = await startMcpPresenterControl(surface, { enforcement: true, account: presenter.account });
	return {
		surface,
		dispose: async () => {
			started?.control.dispose();
			if (started?.dir) await rm(started.dir, { recursive: true, force: true });
		},
	};
}

interface Peer {
	readonly transport: SessionEventWriterConnection;
	capabilities: readonly string[];
	sender?: McpPresenterConnection;
	attached: boolean;
}

function presents(capabilities: readonly string[]): boolean {
	return capabilities.includes("interactive_user") && capabilities.includes("mcp_form_presenter_v1");
}

function writePrivate(transport: SessionEventWriterConnection, record: object): boolean {
	try {
		transport.writeRaw(serializeJsonLine(record));
		return true;
	} catch {
		return false;
	}
}

export class TerminalPresenterSurface implements PresenterHostSurface {
	readonly authority: McpPresenterAuthority;
	/** The TUI owns this authority: a control over it revokes only its own grants when it stops. */
	readonly sharedAuthority = true;
	private readonly binding: McpFormBinding;
	private readonly sessionId: string;
	private readonly peers = new Map<string, Peer>();
	private controlEndpoint?: string;

	private readonly local: LocalMcpPresenter;

	constructor(local: LocalMcpPresenter) {
		this.local = local;
		this.authority = local.authority;
		this.binding = local.binding;
		this.sessionId = local.sessionId;
	}

	attachSealedSecrets(source: SealedSecretSource): () => void {
		const sealed = new TerminalSealedSecrets(source, this.sessionId, this.local.admit);
		this.local.sealed = sealed;
		return () => {
			if (this.local.sealed === sealed) this.local.sealed = undefined;
			sealed.dispose();
		};
	}

	getMcpFormBinding(sessionId: string): McpFormBinding | undefined {
		return sessionId === this.sessionId ? this.binding : undefined;
	}

	findMcpPresenterConnection(nonce: string): McpPresenterConnection | undefined {
		for (const peer of this.peers.values()) if (peer.sender?.nonce === nonce) return peer.sender;
		return undefined;
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		return this.peers.get(id)?.capabilities;
	}

	advertiseMcpPresenterControl(path: string): void {
		this.controlEndpoint = path;
	}

	withdrawMcpPresenterControl(path: string): void {
		if (this.controlEndpoint === path) this.controlEndpoint = undefined;
	}

	opened(id: string, transport: SessionEventWriterConnection): void {
		this.peers.set(id, { transport, capabilities: [], attached: false });
	}

	declare(id: string, capabilities: readonly string[]): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		peer.capabilities = [...capabilities];
		if (!presents(capabilities)) {
			if (peer.sender) this.authority.withdraw(peer.sender);
			return;
		}
		if (!peer.sender) {
			const sender = this.authority.connect(id, (frame) => {
				if (this.peers.get(id) !== peer || !writePrivate(peer.transport, frame)) {
					this.authority.detach(sender);
					return false;
				}
				// A pending drain does not undo an accepted write or drop the next resolution.
				void peer.transport.waitForBackpressure().catch(() => this.authority.detach(sender));
				return true;
			});
			peer.sender = sender;
		}
		if (peer.attached) this.authority.attach(peer.sender, this.binding);
	}

	attach(id: string): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		peer.attached = true;
		if (peer.sender) this.authority.attach(peer.sender, this.binding);
	}

	detach(id: string): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		peer.attached = false;
		if (peer.sender) this.authority.detach(peer.sender, this.binding);
	}

	closed(id: string): void {
		const sender = this.peers.get(id)?.sender;
		this.peers.delete(id);
		if (sender) this.authority.detach(sender);
	}

	/** A private frame from connection `id`, answered on that connection: authority is checked before any lookup. */
	receive(id: string, frame: Readonly<Record<string, unknown>>): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		if (frame.type === "mcp_presenter_secret_answer") {
			const lineId = typeof frame.id === "string" ? { id: frame.id } : {};
			const answered =
				this.local.sealed?.receive(id, frame) ?? Promise.resolve({ error: "secret_answer_refused" as const });
			void answered
				.catch(() => ({ error: "secret_answer_refused" as const }))
				.then((reply) => {
					const written = writePrivate(peer.transport, {
						type: "mcp_presenter_secret_reply",
						...lineId,
						...reply,
					});
					if (!written && peer.sender) this.authority.detach(peer.sender);
				});
			return;
		}
		const sender = peer.sender;
		const reply =
			frame.type === "mcp_presenter_context"
				? presenterContextReply(this.authority, sender, frame, this.controlEndpoint)
				: sender
					? this.authority.receive(sender, frame)
					: { error: "presenter_not_authorized" };
		const answer = { type: "mcp_form_reply", ...(typeof frame.id === "string" ? { id: frame.id } : {}), ...reply };
		if (!writePrivate(peer.transport, answer) && sender) this.authority.detach(sender);
	}
}
