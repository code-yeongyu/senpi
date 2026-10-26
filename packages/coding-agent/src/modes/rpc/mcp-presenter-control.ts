import { createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:net";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
import type { McpPresenterAuthority, McpPresenterRegistration } from "./mcp-presenter-authority.ts";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

type Owner = ReturnType<McpPresenterAuthority["enroll"]>;
interface Principal {
	readonly id: string;
	readonly key: KeyObject;
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
	private readonly successors = new Map<string, { readonly stream: Duplex; readonly write: PassThrough }>();
	private readonly server: Server;
	readonly path: string;

	constructor(writer: SessionEventWriter, path: string) {
		this.writer = writer;
		this.authority = writer.enableMcpPresenters();
		this.path = path;
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
	successorBootstrap(): Duplex | undefined {
		const owner = this.launchOwner;
		if (!owner || owner.stream.destroyed) return undefined;
		const id = randomUUID();
		const toChild = new PassThrough();
		const fromChild = new PassThrough();
		const endpoint = Duplex.from({ readable: Readable.toWeb(toChild), writable: Writable.toWeb(fromChild) });
		this.successors.set(id, { stream: owner.stream, write: toChild });
		const stop = privateFrames(fromChild, (value) => {
			if (!isRecord(value)) {
				endpoint.destroy();
				return;
			}
			if (value.type === "challenge") {
				send(owner.stream, { type: "mcp_presenter_successor_challenge", id, challenge: value });
			} else if (value.type === "enrolled") {
				send(owner.stream, { type: "mcp_presenter_successor_enrolled", id, enrollment: value });
				stop();
				this.successors.delete(id);
			} else endpoint.destroy();
		});
		endpoint.once("close", () => {
			stop();
			this.successors.delete(id);
			toChild.destroy();
			fromChild.destroy();
		});
		toChild.write(
			`${JSON.stringify({
				type: "enroll",
				publicKey: owner.principal.key.export({ type: "spki", format: "pem" }),
				backendGeneration: owner.backendGeneration,
			})}\n`,
		);
		return endpoint;
	}

	/** Only the inherited launch channel may introduce the installation public key. */
	bootstrap(stream: Duplex): void {
		let key: KeyObject | undefined;
		let backend: string | undefined;
		let transcript: string | undefined;
		const id = randomUUID();
		const stop = privateFrames(stream, (value) => {
			if (!key) {
				if (
					!isRecord(value) ||
					value.type !== "enroll" ||
					typeof value.publicKey !== "string" ||
					typeof value.backendGeneration !== "string"
				) {
					stream.destroy();
					return;
				}
				try {
					key = createPublicKey(value.publicKey);
				} catch {
					stream.destroy();
					return;
				}
				if (key.asymmetricKeyType !== "ed25519") {
					stream.destroy();
					return;
				}
				backend = value.backendGeneration;
				transcript = JSON.stringify([
					"mcp-presenter-enroll-v1",
					this.authority.instance,
					backend,
					randomBytes(32).toString("hex"),
				]);
				send(stream, { type: "challenge", transcript, hostInstance: this.authority.instance });
				return;
			}
			if (!transcript || !signed(value, transcript, key)) {
				stream.destroy();
				return;
			}
			this.principals.set(id, { id, key, sessions: new WeakSet() });
			send(stream, {
				type: "enrolled",
				principalId: id,
				hostInstance: this.authority.instance,
				backendGeneration: backend,
				endpoint: this.path,
			});
			stop();
			stream.end();
		});
	}

	dispose(): void {
		this.authority.dispose();
		for (const stream of this.controls) stream.destroy();
		this.controls.clear();
		for (const successor of this.successors.values()) successor.write.destroy();
		this.successors.clear();
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
			for (const [id, successor] of this.successors)
				if (successor.stream === stream) {
					successor.write.destroy();
					this.successors.delete(id);
				}
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
				if (value.type === "mcp_presenter_successor_proof" && typeof value.id === "string") {
					const successor = this.successors.get(value.id);
					if (successor?.stream !== stream || typeof value.signature !== "string") {
						stream.destroy();
						return;
					}
					successor.write.write(`${JSON.stringify({ type: "proof", signature: value.signature })}\n`);
					return;
				}
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

function signed(value: unknown, transcript: string, key: KeyObject): boolean {
	if (
		!isRecord(value) ||
		value.type !== "proof" ||
		typeof value.signature !== "string" ||
		!/^[a-f0-9]{128}$/.test(value.signature)
	)
		return false;
	return verify(null, Buffer.from(transcript), key, Buffer.from(value.signature, "hex"));
}

function send(stream: Duplex, value: object): void {
	if (!stream.write(`${JSON.stringify(value)}\n`)) stream.destroy();
}

/** Bound before parsing. Neither malformed bodies nor parser exceptions enter diagnostics. */
function privateFrames(stream: Duplex, receive: (value: unknown) => void, deadline = true): () => void {
	const timer = deadline ? setTimeout(() => stream.destroy(), 30_000) : undefined;
	const detach = attachJsonlLineReader(
		stream,
		(line) => {
			try {
				receive(JSON.parse(line));
			} catch {
				stream.destroy();
			}
		},
		{ maxLineLength: 16 * 1024, onOversizedLine: () => stream.destroy() },
	);
	stream.on("error", () => stream.destroy());
	stream.once("close", () => {
		clearTimeout(timer);
		detach();
	});
	return () => {
		clearTimeout(timer);
		detach();
	};
}
