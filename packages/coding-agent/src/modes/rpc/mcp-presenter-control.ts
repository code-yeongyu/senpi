import { createServer, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { accountIdentity, McpPresenterAccounts, type PresenterAccountAuthority } from "./mcp-presenter-account.ts";
import type { McpPresenterAuthority, McpPresenterRegistration } from "./mcp-presenter-authority.ts";
import {
	runPresenterCommand,
	type PresenterOwner,
	type PresenterPrincipalRecord,
} from "./mcp-presenter-control-commands.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";
import { McpPresenterEnrollment } from "./mcp-presenter-enrollment.ts";
import { SealedSecretHolders } from "./secret-sealed-holders.ts";
import { McpPresenterSuccessors, type LaunchOwner } from "./mcp-presenter-successor.ts";
import { challengeTranscript, privateFrames, send, signed } from "./mcp-presenter-wire.ts";

/** Separate authenticated control endpoint. Ordinary RPC credentials cannot enroll or acquire. */
export class McpPresenterControl {
	private readonly host: PresenterHostSurface;
	private readonly authority: McpPresenterAuthority;
	private readonly principals = new Map<string, PresenterPrincipalRecord>();
	private readonly controls = new Set<Duplex>();
	private readonly revokeControls = new Map<Duplex, () => void>();
	private launchOwner?: LaunchOwner;
	private readonly backendGenerations = new Map<Duplex, { principal: PresenterPrincipalRecord; generation: string }>();
	private readonly enrollment: McpPresenterEnrollment;
	private readonly successors: McpPresenterSuccessors;
	private readonly accounts: McpPresenterAccounts;
	private readonly server: Server;
	private readonly account: PresenterAccountAuthority | undefined;
	/** The sealed secret route's holders and host token cache (D11 secret phase); absent without both seam methods. */
	readonly sealed: SealedSecretHolders | undefined;
	readonly path: string;

	constructor(host: PresenterHostSurface, path: string, account?: PresenterAccountAuthority) {
		this.host = host;
		this.authority = host.authority;
		this.path = path;
		this.account = account;
		this.enrollment = new McpPresenterEnrollment(this.authority.instance, path);
		this.successors = new McpPresenterSuccessors(this.authority.instance, this.enrollment.nonces);
		this.accounts = new McpPresenterAccounts(this.authority.instance, this.principals, account, (stream) =>
			this.revokeControls.get(stream)?.(),
		);
		this.sealed = SealedSecretHolders.create(host, account, this.principals);
		this.server = createServer((stream) => this.manage(stream));
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.path, () => {
				this.server.off("error", reject);
				// Only a listening endpoint that can enroll a same-account presenter is discoverable (senpi#4249).
				if (this.account) this.host.advertiseMcpPresenterControl(this.path);
				resolve();
			});
		});
	}

	/** A deferred handover is spawned by the old host, not the CLI that already returned. */
	successorBootstrap(): Promise<Duplex | undefined> {
		const owner = this.launchOwner;
		return owner ? this.successors.prepare(owner) : Promise.resolve(undefined);
	}

	/**
	 * The deferred form (senpi#4602): a provider when an owner can authorize a successor at all, called only when that
	 * successor reaches its P7, so the fresh permit's 30 s window covers the exchange and not the successor's boot.
	 */
	successorBootstrapProvider(): (() => Promise<Duplex | undefined>) | undefined {
		return this.launchOwner ? () => this.successorBootstrap() : undefined;
	}

	/** Only the inherited launch channel may introduce the installation public key. */
	bootstrap(stream: Duplex): void {
		this.enrollment.bootstrap(stream, (principal) => {
			this.principals.set(principal.id, { ...principal, kind: "inherited", sessions: new WeakSet() });
		});
	}

	dispose(): void {
		this.sealed?.dispose();
		this.host.withdrawMcpPresenterControl(this.path);
		const streams = [...this.controls];
		for (const revoke of [...this.revokeControls.values()]) revoke();
		if (!this.host.sharedAuthority) this.authority.dispose();
		for (const stream of streams) stream.destroy();
		this.controls.clear();
		this.successors.dispose();
		this.accounts.dispose();
		this.enrollment.dispose();
		this.principals.clear();
		this.server.close();
	}

	private manage(stream: Duplex): void {
		if (this.controls.size >= 64) {
			stream.destroy();
			return;
		}
		this.controls.add(stream);
		let principal: PresenterPrincipalRecord | undefined;
		let owner: PresenterOwner | undefined;
		let transcript: string | undefined;
		let pending: Record<string, unknown> | undefined;
		let backendGeneration: string | undefined;
		let deadline = performance.now() + 30_000;
		let challengeTimer: NodeJS.Timeout | undefined = setTimeout(() => stream.destroy(), 30_000);
		const registrations = new Map<string, McpPresenterRegistration>();
		const revoke = () => {
			clearTimeout(challengeTimer);
			for (const registration of registrations.values()) owner?.revoke(registration);
			registrations.clear();
			this.controls.delete(stream);
			this.revokeControls.delete(stream);
			this.backendGenerations.delete(stream);
			if (this.launchOwner?.stream === stream) this.launchOwner = undefined;
			this.successors.revoke(stream);
		};
		this.revokeControls.set(stream, revoke);
		stream.once("close", revoke);
		const stop = privateFrames(
			stream,
			(value) => {
				if (!isRecord(value)) {
					stream.destroy();
					return;
				}
				if (this.successors.receive(stream, value)) return;
				if (this.accounts.receive(stream, value, !principal && !pending, () => clearTimeout(challengeTimer)))
					return;
				if (value.type === "challenge") {
					if (
						pending ||
						typeof value.principalId !== "string" ||
						typeof value.backendGeneration !== "string" ||
						!isRecord(value.command)
					) {
						stream.destroy();
						return;
					}
					const requested = this.principals.get(value.principalId);
					// An account principal is managed only on the stream it enrolled on (D11 S3-2).
					const foreign = requested?.kind === "account" && requested.stream !== stream;
					if (!requested || foreign || (principal && principal !== requested)) {
						stream.destroy();
						return;
					}
					principal = requested;
					backendGeneration = value.backendGeneration;
					pending = value.command;
					deadline = performance.now() + 30_000;
					clearTimeout(challengeTimer);
					challengeTimer = setTimeout(() => stream.destroy(), 30_000);
					transcript = challengeTranscript(this.authority.instance, value.backendGeneration, pending);
					send(stream, { type: "challenge", transcript, hostInstance: this.authority.instance });
					return;
				}
				if (
					!principal ||
					!pending ||
					!transcript ||
					performance.now() >= deadline ||
					!signed(value, transcript, principal.key)
				) {
					stream.destroy();
					return;
				}
				const command = pending;
				clearTimeout(challengeTimer);
				pending = undefined;
				transcript = undefined;
				if (this.accounts.lapsed(principal)) return;
				owner ??= this.authority.enroll(
					principal.id,
					principal.kind === "account" ? accountIdentity(principal) : undefined,
				);
				if (backendGeneration === undefined) {
					stream.destroy();
					return;
				}
				for (const [oldStream, old] of this.backendGenerations) {
					if (old.principal === principal && old.generation !== backendGeneration) {
						this.revokeControls.get(oldStream)?.();
						oldStream.destroy();
					}
				}
				this.backendGenerations.set(stream, { principal, generation: backendGeneration });
				// Only the inherited launch principal can authorize a successor; never an adopted device (D11 T7).
				if (principal.kind === "inherited") this.launchOwner = { stream, principal, backendGeneration };
				const id = typeof command.id === "string" ? command.id : undefined;
				try {
					runPresenterCommand(command, {
						host: this.host,
						authority: this.authority,
						stream,
						id,
						principal,
						owner,
						registrations,
						sealed: this.sealed,
					});
				} catch {
					send(stream, { type: "mcp_presenter_error", id, error: "presenter_not_authorized" });
				}
			},
			false,
		);
		stream.once("close", stop);
	}
}
