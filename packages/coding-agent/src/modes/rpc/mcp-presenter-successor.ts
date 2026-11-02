import { randomUUID } from "node:crypto";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import {
	parsePresenterEnrollment,
	presenterEnrollmentTranscript,
	type PresenterPrincipal,
} from "./mcp-presenter-enrollment.ts";
import { privateFrames, send } from "./mcp-presenter-wire.ts";

interface LaunchOwner {
	readonly stream: Duplex;
	readonly principal: PresenterPrincipal;
	readonly backendGeneration: string;
}

interface Successor {
	readonly owner: LaunchOwner;
	readonly receive: (value: Record<string, unknown>) => void;
	readonly close: () => void;
}

/** Only an authenticated owner can issue a fresh permit at the actual deferred launch. */
export class McpPresenterSuccessors {
	private readonly pending = new Map<string, Successor>();
	private readonly predecessor: string;
	private readonly nonces: Set<string>;

	constructor(predecessor: string, nonces: Set<string>) {
		this.predecessor = predecessor;
		this.nonces = nonces;
	}

	prepare(owner: LaunchOwner): Promise<Duplex | undefined> {
		if (owner.stream.destroyed || this.pending.size) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const id = randomUUID();
			const deadline = performance.now() + 30_000;
			const timer = setTimeout(() => close(), 30_000);
			let endpoint: Duplex | undefined;
			let proof: ((signature: string) => void) | undefined;
			let stop = () => {};
			const close = () => {
				clearTimeout(timer);
				stop();
				this.pending.delete(id);
				endpoint?.destroy();
				resolve(undefined);
			};
			this.pending.set(id, {
				owner,
				close,
				receive: (value) => {
					if (performance.now() >= deadline) return close();
					if (value.type === "mcp_presenter_successor_proof" && proof && typeof value.signature === "string") {
						const forward = proof;
						proof = undefined;
						forward(value.signature);
						return;
					}
					if (value.type !== "mcp_presenter_successor_authorize" || endpoint) return close();
					const request = parsePresenterEnrollment(value.enrollment);
					const previous = owner.principal.enrollment;
					if (
						!request ||
						request.launchKind !== "replacement" ||
						request.predecessorHostInstance !== this.predecessor ||
						request.backendGeneration !== owner.backendGeneration ||
						request.installationKeyId !== previous.installationKeyId ||
						request.environmentId !== previous.environmentId ||
						JSON.stringify(request.executionRealm) !== JSON.stringify(previous.executionRealm) ||
						this.nonces.has(request.launchRequestNonce)
					)
						return close();
					this.nonces.add(request.launchRequestNonce);
					const toChild = new PassThrough();
					const fromChild = new PassThrough();
					endpoint = Duplex.from({ readable: Readable.toWeb(toChild), writable: Writable.toWeb(fromChild) });
					endpoint.once("close", () => {
						toChild.destroy();
						fromChild.destroy();
						close();
					});
					let incarnation: string | undefined;
					stop = privateFrames(fromChild, (frame) => {
						if (performance.now() >= deadline || !isRecord(frame)) return close();
						if (frame.type === "challenge" && !incarnation && frame.version === 2) {
							if (
								typeof frame.hostInstance !== "string" ||
								frame.hostInstance === this.predecessor ||
								typeof frame.transcript !== "string"
							)
								return close();
							const tuple: unknown = JSON.parse(frame.transcript);
							if (
								!Array.isArray(tuple) ||
								typeof tuple[10] !== "string" ||
								!/^[a-f0-9]{64}$/.test(tuple[10]) ||
								frame.transcript !== presenterEnrollmentTranscript(request, frame.hostInstance, tuple[10])
							)
								return close();
							incarnation = frame.hostInstance;
							proof = (signature) => toChild.write(`${JSON.stringify({ type: "proof", signature })}\n`);
							send(owner.stream, { type: "mcp_presenter_successor_challenge", id, challenge: frame });
						} else if (
							frame.type === "enrolled" &&
							incarnation &&
							!proof &&
							frame.version === 2 &&
							frame.hostInstance === incarnation &&
							frame.launchRequestNonce === request.launchRequestNonce &&
							frame.backendGeneration === request.backendGeneration
						) {
							send(owner.stream, { type: "mcp_presenter_successor_enrolled", id, enrollment: frame });
							close();
						} else close();
					});
					toChild.write(`${JSON.stringify(request)}\n`);
					resolve(endpoint);
				},
			});
			send(owner.stream, {
				type: "mcp_presenter_successor_prepare",
				id,
				version: 2,
				launchKind: "replacement",
				predecessorHostInstance: this.predecessor,
				backendGeneration: owner.backendGeneration,
			});
		});
	}

	receive(stream: Duplex, value: Record<string, unknown>): boolean {
		if (value.type !== "mcp_presenter_successor_authorize" && value.type !== "mcp_presenter_successor_proof")
			return false;
		const pending = typeof value.id === "string" ? this.pending.get(value.id) : undefined;
		if (!pending || pending.owner.stream !== stream) stream.destroy();
		else pending.receive(value);
		return true;
	}

	revoke(stream: Duplex): void {
		for (const pending of this.pending.values()) if (pending.owner.stream === stream) pending.close();
	}

	dispose(): void {
		for (const pending of this.pending.values()) pending.close();
	}
}
