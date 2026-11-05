import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { PresenterAccountAuthority } from "../../../src/modes/rpc/mcp-presenter-account.ts";
import { startMcpPresenterControl } from "../../../src/modes/rpc/mcp-presenter-control-start.ts";
import { isRecord } from "../../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { presenterIssuer } from "./presenter-account-issuer.ts";
import { enrollmentPeer } from "./presenter-enrollment.ts";

export type Peer = ReturnType<typeof enrollmentPeer>;
export type Frame = Record<string, unknown> | undefined;
export type Installation = ReturnType<typeof installation>;
export type AccountHost = Awaited<ReturnType<typeof accountHost>>;

export const issuer = presenterIssuer();
const disposals: Array<() => unknown> = [];

export async function closeAccountHosts(): Promise<void> {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
}

export function installation() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const installationKeyId = createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" }))
		.digest("hex");
	const frame = (attestation: string) => ({
		type: "account_enroll",
		version: 1,
		purpose: "mcp_form",
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
		installationKeyId,
		attestation,
	});
	return { publicKey, privateKey, installationKeyId, frame };
}

export function proof(transcript: unknown, key: KeyObject) {
	return { type: "proof", signature: sign(null, Buffer.from(String(transcript)), key).toString("hex") };
}

export async function connectedPair(): Promise<{ hostSide: Socket; peerSide: Socket }> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	const accepted = once(server, "connection");
	const peerSide = connect(address.port, "127.0.0.1");
	const [hostSide]: Socket[] = await accepted;
	server.close();
	disposals.push(() => {
		hostSide.destroy();
		peerSide.destroy();
	});
	return { hostSide, peerSide };
}

/** An RPC connection attached to `session` as a capable presenter; it collects its private form requests. */
function presenterConnection(writer: SessionEventWriter, id: string, lines: string[] = []) {
	const requests: Record<string, unknown>[] = [];
	const waiters: Array<(request: Record<string, unknown>) => void> = [];
	const writeRaw = (line: string) => {
		lines.push(line);
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.type !== "mcp_form_request") return;
		const waiter = waiters.shift();
		if (waiter) waiter(value);
		else requests.push(value);
	};
	writer.registerConnection(id, { writeRaw, waitForBackpressure: async () => {} });
	writer.setConnectionCapabilities(id, ["interactive_user", "mcp_form_presenter_v1"]);
	writer.attachConnectionToSession(id, "session");
	const connection = writer.getMcpPresenterConnection(id);
	const context = connection && writer.mcpPresenters?.connectionContext(connection, "session");
	if (!connection || !context) throw new Error("Fixture presenter connection missing");
	const request = (): Promise<Record<string, unknown>> => {
		const queued = requests.shift();
		return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
	};
	return { id, connection, context, request, unread: () => requests.length };
}

type AccountState = { account: string | undefined; readonly listeners: Set<() => void> };

export async function accountHost(
	options: {
		authority?: boolean;
		inheritedBootstrap?: Duplex;
		account?: (state: AccountState) => PresenterAccountAuthority;
	} = {},
) {
	const state: AccountState = {
		account: "account-a",
		listeners: new Set(),
	};
	const lines: string[] = [];
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	writer.bindMcpForms("session", "durable", {}, () => {});
	const human = presenterConnection(writer, "human", lines);
	const binding = writer.getMcpFormBinding("session");
	if (!binding) throw new Error("Fixture binding missing");
	const started = await startMcpPresenterControl(writer, {
		enforcement: true,
		...(options.authority !== false && { account: (options.account ?? issuer.authority)(state) }),
		...(options.inheritedBootstrap && { bootstrap: options.inheritedBootstrap }),
	});
	if (!started) throw new Error("No presenter control");
	disposals.push(async () => {
		started.control.dispose();
		if (started.dir) await rm(started.dir, { recursive: true, force: true });
	});
	const open = (): Peer & { close: () => void } => {
		const socket = connect(started.control.path);
		disposals.push(() => socket.destroy());
		return { ...enrollmentPeer(socket), close: () => socket.destroy() };
	};
	/** The distribution's sign-out or account-switch event. */
	const switchAccount = (account: string | undefined) => {
		state.account = account;
		for (const listener of [...state.listeners]) listener();
	};
	return {
		state,
		lines,
		writer,
		authority,
		binding,
		human,
		context: human.context,
		control: started.control,
		open,
		switchAccount,
		presenter: (id: string) => presenterConnection(writer, id),
	};
}

export async function enroll(peer: Peer, device: Installation, token: string, signer = device.privateKey) {
	peer.send(device.frame(token));
	const challenge = await peer.next();
	if (challenge?.type !== "challenge") return { challenge, reply: challenge };
	peer.send(proof(challenge.transcript, signer));
	return { challenge, reply: await peer.next() };
}

export async function signedCommand(peer: Peer, principalId: unknown, key: KeyObject, command: object): Promise<Frame> {
	peer.send({ type: "challenge", principalId, backendGeneration: "backend", command });
	const challenge = await peer.next();
	if (challenge?.type !== "challenge") return challenge;
	peer.send(proof(challenge.transcript, key));
	return peer.next();
}

export async function enrollAssignAcquire(
	host: AccountHost,
	device = installation(),
	options: {
		readonly context?: AccountHost["context"];
		readonly claims?: Record<string, unknown>;
		readonly features?: readonly string[];
	} = {},
) {
	const peer = host.open();
	const token = issuer.mint(device.publicKey, options.claims);
	const { challenge, reply } = await enroll(peer, device, token);
	const principalId = reply?.principalId;
	const assigned = await signedCommand(peer, principalId, device.privateKey, {
		type: "mcp_presenter_assign",
		sessionId: "session",
		bindingEpoch: host.binding.epoch,
		purpose: "mcp_form",
	});
	const acquired = await signedCommand(peer, principalId, device.privateKey, {
		type: "mcp_presenter_acquire",
		id: "acquire",
		...(options.context ?? host.context),
		sessionId: "session",
		kind: "desktop",
		purpose: "mcp_form",
		...(options.features && { features: options.features }),
	});
	return { peer, device, token, challenge, reply, principalId, assigned, acquired };
}

export function claimsOf(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
}

/** Offers one ordinary form through the session's current holder. */
export function offer(host: AccountHost) {
	const presentation = host.binding.capture();
	if (!presentation) throw new Error("No presenter holds the session");
	return presentation.present({
		operationId: "operation",
		inputId: "input",
		round: 0,
		server: { label: "server", source: "user" },
		message: "message",
		schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		operationSignal: new AbortController().signal,
		presentationSignal: new AbortController().signal,
		deadlineMs: 3_600_000,
	});
}

export function envelopeOf(request: Record<string, unknown>) {
	const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = request;
	return { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
}
