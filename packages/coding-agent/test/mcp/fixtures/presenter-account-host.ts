import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { startMcpPresenterControl } from "../../../src/modes/rpc/mcp-presenter-control-start.ts";
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

export async function accountHost(options: { authority?: boolean; inheritedBootstrap?: Duplex } = {}) {
	const state: { account: string | undefined } = { account: "account-a" };
	const lines: string[] = [];
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	writer.registerConnection("human", { writeRaw: (line) => lines.push(line), waitForBackpressure: async () => {} });
	writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1"]);
	writer.bindMcpForms("session", "durable", {}, () => {});
	writer.attachConnectionToSession("human", "session");
	const binding = writer.getMcpFormBinding("session");
	const connection = writer.getMcpPresenterConnection("human");
	if (!binding || !connection) throw new Error("Fixture binding missing");
	const started = await startMcpPresenterControl(writer, {
		enforcement: true,
		...(options.authority !== false && { account: issuer.authority(state) }),
		...(options.inheritedBootstrap && { bootstrap: options.inheritedBootstrap }),
	});
	if (!started) throw new Error("No presenter control");
	disposals.push(async () => {
		started.control.dispose();
		if (started.dir) await rm(started.dir, { recursive: true, force: true });
	});
	const open = (): Peer => {
		const socket = connect(started.control.path);
		disposals.push(() => socket.destroy());
		return enrollmentPeer(socket);
	};
	const context = authority.connectionContext(connection, "session");
	return { state, lines, writer, binding, context, control: started.control, open };
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

export async function enrollAssignAcquire(host: AccountHost, device = installation()) {
	const peer = host.open();
	const token = issuer.mint(device.publicKey);
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
		...host.context,
		sessionId: "session",
		kind: "desktop",
		purpose: "mcp_form",
	});
	return { peer, device, token, challenge, reply, principalId, assigned, acquired };
}

export function claimsOf(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
}
