import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { McpPresenterAuthority, McpPresenterRegistration } from "./mcp-presenter-authority.ts";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import { McpPresenterEnrollment, type PresenterPrincipal } from "./mcp-presenter-enrollment.ts";
import { McpPresenterSuccessors } from "./mcp-presenter-successor.ts";
import { privateFrames, send, signed } from "./mcp-presenter-wire.ts";

type Owner = ReturnType<McpPresenterAuthority["enroll"]>;
interface Principal extends PresenterPrincipal {
	readonly sessions: WeakSet<McpFormBinding>;
}

/** Separate authenticated control endpoint. Ordinary RPC credentials cannot enroll or acquire. */
export class McpPresenterControl {
	private readonly writer: SessionEventWriter;
	private readonly authority: McpPresenterAuthority;
	private readonly principals = new Map<string, Principal>();
	private readonly controls = new Set<Duplex>();
	private readonly revokeControls = new Map<Duplex, () => void>();
	private launchOwner?: { readonly stream: Duplex; readonly principal: Principal; readonly backendGeneration: string };
	private readonly backendGenerations = new Map<Duplex, { principal: Principal; generation: string }>();
	private readonly enrollment: McpPresenterEnrollment;
	private readonly successors: McpPresenterSuccessors;
	private readonly server: Server;
	readonly path: string;

	constructor(writer: SessionEventWriter, path: string) {
		this.writer = writer;
		this.authority = writer.enableMcpPresenters();
		this.path = path;
		this.enrollment = new McpPresenterEnrollment(this.authority.instance, path);
		this.successors = new McpPresenterSuccessors(this.authority.instance, this.enrollment.nonces);
		this.server = createServer((stream) => this.manage(stream));
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.path, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
	}

	/** A deferred handover is spawned by the old host, not the CLI that already returned. */
	successorBootstrap(): Promise<Duplex | undefined> {
		const owner = this.launchOwner;
		return owner ? this.successors.prepare(owner) : Promise.resolve(undefined);
	}

	/** Only the inherited launch channel may introduce the installation public key. */
	bootstrap(stream: Duplex): void {
		this.enrollment.bootstrap(stream, (principal) => {
			this.principals.set(principal.id, { ...principal, sessions: new WeakSet() });
		});
	}

	dispose(): void {
		this.authority.dispose();
		for (const stream of this.controls) stream.destroy();
		this.controls.clear();
		this.successors.dispose();
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
		let principal: Principal | undefined;
		let owner: Owner | undefined;
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
					if (!requested || (principal && principal !== requested)) {
						stream.destroy();
						return;
					}
					principal = requested;
					backendGeneration = value.backendGeneration;
					pending = value.command;
					deadline = performance.now() + 30_000;
					clearTimeout(challengeTimer);
					challengeTimer = setTimeout(() => stream.destroy(), 30_000);
					transcript = JSON.stringify([
						"mcp-presenter-control-v1",
						this.authority.instance,
						value.backendGeneration,
						randomUUID(),
						randomBytes(32).toString("hex"),
						pending,
					]);
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
				owner ??= this.authority.enroll(principal.id);
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
				this.launchOwner = { stream, principal, backendGeneration };
				const id = typeof command.id === "string" ? command.id : undefined;
				try {
					switch (command.type) {
						case "mcp_presenter_assign": {
							const binding =
								typeof command.sessionId === "string"
									? this.writer.getMcpFormBinding(command.sessionId)
									: undefined;
							if (!binding || binding.epoch !== command.bindingEpoch || command.purpose !== "mcp_form")
								throw new Error("presenter_not_authorized");
							// Only a signed native-supervisor decision assigns an opened/adopted session.
							// Enrollment and ordinary RPC attachment do not imply assignment.
							principal.sessions.add(binding);
							send(stream, { type: "mcp_presenter_assigned", id, sessionId: command.sessionId });
							return;
						}
						case "mcp_presenter_acquire": {
							if (
								command.hostInstance !== this.authority.instance ||
								typeof command.sessionId !== "string" ||
								typeof command.bindingEpoch !== "string" ||
								typeof command.connectionNonce !== "string" ||
								(command.kind !== "desktop" && command.kind !== "gateway")
							)
								throw new Error("presenter_not_authorized");
							const binding = this.writer.getMcpFormBinding(command.sessionId);
							const connection = this.writer.findMcpPresenterConnection(command.connectionNonce);
							if (
								!binding ||
								!principal.sessions.has(binding) ||
								binding.epoch !== command.bindingEpoch ||
								!connection
							)
								throw new Error("presenter_not_authorized");
							const capabilities = this.writer.getConnectionCapabilities(connection.id);
							if (!capabilities?.includes("interactive_user") || !capabilities.includes("mcp_form_presenter_v1"))
								throw new Error("presenter_not_authorized");
							const context = this.authority.connectionContext(connection, command.sessionId);
							if (
								!context ||
								command.purpose !== "mcp_form" ||
								command.attachmentId !== context.attachmentId ||
								command.attachmentEpoch !== context.attachmentEpoch
							)
								throw new Error("presenter_not_authorized");
							const registration = owner.register(binding, connection, { kind: command.kind });
							const grant = owner.acquire(registration);
							registrations.set(registration.id, registration);
							send(stream, { type: "mcp_presenter_acquired", id, registrationId: registration.id, ...grant });
							return;
						}
						case "mcp_presenter_revoke": {
							const registration =
								typeof command.registrationId === "string"
									? registrations.get(command.registrationId)
									: undefined;
							if (!registration) throw new Error("presenter_not_authorized");
							owner.revoke(registration);
							registrations.delete(registration.id);
							send(stream, { type: "mcp_presenter_revoked", id });
							return;
						}
						default:
							throw new Error("presenter_not_authorized");
					}
				} catch {
					send(stream, { type: "mcp_presenter_error", id, error: "presenter_not_authorized" });
				}
			},
			false,
		);
		stream.once("close", stop);
	}
}
