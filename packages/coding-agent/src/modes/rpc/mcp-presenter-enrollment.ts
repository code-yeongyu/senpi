import { createHash, createPublicKey, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { privateFrames, send, signed } from "./mcp-presenter-wire.ts";

export interface PresenterEnrollment {
	readonly type: "enroll";
	readonly version: 2;
	readonly purpose: "mcp_form";
	readonly publicKey: string;
	readonly installationKeyId: string;
	readonly backendGeneration: string;
	readonly launchRequestNonce: string;
	readonly launchKind: "initial" | "replacement";
	readonly predecessorHostInstance: string | null;
	readonly executionRealm: readonly ["native"] | readonly ["wsl", string, string];
	readonly environmentId: string;
}

export interface PresenterPrincipal {
	readonly id: string;
	readonly key: KeyObject;
	readonly enrollment: PresenterEnrollment;
}

function identity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** The Ed25519 key a request names, only when `installationKeyId` is the SHA-256 of its SPKI DER. */
function installationKey(publicKey: unknown, installationKeyId: unknown): KeyObject | undefined {
	if (typeof publicKey !== "string" || publicKey.length > 1024) return undefined;
	if (typeof installationKeyId !== "string" || !/^[a-f0-9]{64}$/.test(installationKeyId)) return undefined;
	try {
		const key = createPublicKey(publicKey);
		const spki = key.export({ type: "spki", format: "der" });
		if (key.asymmetricKeyType !== "ed25519") return undefined;
		return createHash("sha256").update(spki).digest("hex") === installationKeyId ? key : undefined;
	} catch {
		return undefined;
	}
}

/** A parsed `account_enroll` (D11): the same key binding as `enroll`, plus the issuer attestation. */
export interface AccountEnrollment {
	readonly key: KeyObject;
	readonly installationKeyId: string;
	readonly attestation: string;
}

/** Exact v1 account boundary. No additional fields can become unsigned authorization inputs. */
export function parseAccountEnrollment(value: unknown): AccountEnrollment | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 6 ||
		value.type !== "account_enroll" ||
		value.version !== 1 ||
		value.purpose !== "mcp_form" ||
		typeof value.installationKeyId !== "string" ||
		typeof value.attestation !== "string" ||
		value.attestation.length > 8192
	)
		return undefined;
	const key = installationKey(value.publicKey, value.installationKeyId);
	return key && { key, installationKeyId: value.installationKeyId, attestation: value.attestation };
}

/** The fixed tuple an account presenter signs; JSON.stringify of it is the canonical UTF-8 encoding. */
export function accountEnrollmentTranscript(
	hostInstance: string,
	hostAccount: string,
	claims: { readonly acc: string; readonly dev: string; readonly jti: string },
	installationKeyId: string,
	nonce: string,
): string {
	return JSON.stringify([
		"mcp-presenter-account-enroll-v1",
		"mcp_form",
		hostInstance,
		hostAccount,
		claims.acc,
		claims.dev,
		installationKeyId,
		claims.jti,
		nonce,
		30000,
	]);
}

/** Exact v2 boundary. No additional fields can become unsigned authorization inputs. */
export function parsePresenterEnrollment(value: unknown): PresenterEnrollment | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 11 ||
		value.type !== "enroll" ||
		value.version !== 2 ||
		value.purpose !== "mcp_form" ||
		typeof value.publicKey !== "string" ||
		value.publicKey.length > 1024 ||
		typeof value.installationKeyId !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.installationKeyId) ||
		!identity(value.backendGeneration) ||
		typeof value.launchRequestNonce !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.launchRequestNonce) ||
		(value.launchKind !== "initial" && value.launchKind !== "replacement") ||
		!identity(value.environmentId)
	)
		return undefined;
	const predecessor = value.predecessorHostInstance;
	if (value.launchKind === "initial" ? predecessor !== null : !identity(predecessor)) return undefined;
	if (predecessor !== null && typeof predecessor !== "string") return undefined;
	const realm = value.executionRealm;
	if (!Array.isArray(realm)) return undefined;
	let executionRealm: PresenterEnrollment["executionRealm"];
	if (realm.length === 1 && realm[0] === "native") executionRealm = ["native"];
	else if (realm.length === 3 && realm[0] === "wsl" && identity(realm[1]) && identity(realm[2]))
		executionRealm = ["wsl", realm[1], realm[2]];
	else return undefined;
	if (!installationKey(value.publicKey, value.installationKeyId)) return undefined;
	return {
		type: "enroll",
		version: 2,
		purpose: "mcp_form",
		publicKey: value.publicKey,
		installationKeyId: value.installationKeyId,
		backendGeneration: value.backendGeneration,
		launchRequestNonce: value.launchRequestNonce,
		launchKind: value.launchKind,
		predecessorHostInstance: predecessor,
		executionRealm,
		environmentId: value.environmentId,
	};
}

/** JSON.stringify on this fixed primitive tuple is the canonical UTF-8 signed encoding. */
export function presenterEnrollmentTranscript(
	request: PresenterEnrollment,
	hostInstance: string,
	nonce: string,
): string {
	return JSON.stringify([
		"mcp-presenter-enroll-v2",
		request.purpose,
		request.installationKeyId,
		request.backendGeneration,
		request.launchRequestNonce,
		request.launchKind,
		request.predecessorHostInstance,
		request.executionRealm,
		request.environmentId,
		hostInstance,
		nonce,
		30000,
	]);
}

/** One bootstrap opportunity per host incarnation, including failed or cancelled attempts. */
export class McpPresenterEnrollment {
	private started = false;
	private stream?: Duplex;
	readonly nonces = new Set<string>();
	private readonly hostInstance: string;
	private readonly endpoint: string;

	constructor(hostInstance: string, endpoint: string) {
		this.hostInstance = hostInstance;
		this.endpoint = endpoint;
	}

	bootstrap(stream: Duplex, enrolled: (principal: PresenterPrincipal) => void): void {
		if (this.started) {
			stream.destroy();
			return;
		}
		this.started = true;
		this.stream = stream;
		let pending: { request: PresenterEnrollment; key: KeyObject; transcript: string; deadline: number } | undefined;
		let consumed = false;
		const stop = privateFrames(
			stream,
			(value) => {
				if (consumed) return;
				if (!pending) {
					if (isRecord(value) && value.type === "enroll" && value.version !== 2) {
						consumed = true;
						stop();
						stream.end(`${JSON.stringify({ type: "unavailable", versions: [2] })}\n`);
						return;
					}
					const request = parsePresenterEnrollment(value);
					if (!request || request.predecessorHostInstance === this.hostInstance) {
						stream.destroy();
						return;
					}
					this.nonces.add(request.launchRequestNonce);
					pending = {
						request,
						key: createPublicKey(request.publicKey),
						transcript: presenterEnrollmentTranscript(
							request,
							this.hostInstance,
							randomBytes(32).toString("hex"),
						),
						deadline: performance.now() + 30_000,
					};
					send(stream, {
						type: "challenge",
						version: 2,
						transcript: pending.transcript,
						hostInstance: this.hostInstance,
					});
					return;
				}
				const attempt = pending;
				consumed = true;
				pending = undefined;
				stop();
				if (performance.now() >= attempt.deadline || !signed(value, attempt.transcript, attempt.key)) {
					stream.destroy();
					return;
				}
				const principal = { id: randomUUID(), key: attempt.key, enrollment: attempt.request };
				enrolled(principal);
				stream.end(
					`${JSON.stringify({
						type: "enrolled",
						version: 2,
						principalId: principal.id,
						hostInstance: this.hostInstance,
						backendGeneration: attempt.request.backendGeneration,
						launchRequestNonce: attempt.request.launchRequestNonce,
						endpoint: this.endpoint,
					})}\n`,
				);
			},
			// A successor's exchange starts at its P7, not when this host opened the channel (senpi#4602).
			"parked",
		);
	}

	dispose(): void {
		this.stream?.destroy();
		this.nonces.clear();
	}
}
