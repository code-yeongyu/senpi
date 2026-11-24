import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { isRecord } from "../../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { McpPresenterControl } from "../../../src/modes/rpc/mcp-presenter-control.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

export const enrollmentKey = generateKeyPairSync("ed25519");

export function enrollmentRequest(overrides: Record<string, unknown> = {}) {
	return {
		type: "enroll",
		version: 2,
		purpose: "mcp_form",
		publicKey: enrollmentKey.publicKey.export({ type: "spki", format: "pem" }),
		installationKeyId: createHash("sha256")
			.update(enrollmentKey.publicKey.export({ type: "spki", format: "der" }))
			.digest("hex"),
		backendGeneration: "backend-4254",
		launchRequestNonce: randomBytes(32).toString("hex"),
		launchKind: "initial",
		predecessorHostInstance: null,
		executionRealm: ["native"],
		environmentId: "environment-4254",
		...overrides,
	};
}

export function enrollmentProof(transcript: unknown) {
	if (typeof transcript !== "string") throw new Error("Missing enrollment transcript");
	return {
		type: "proof",
		signature: sign(null, Buffer.from(transcript), enrollmentKey.privateKey).toString("hex"),
	};
}

export function enrollmentPeer(socket: Socket) {
	socket.on("error", (error) => {
		if (!("code" in error) || error.code !== "ECONNRESET") throw error;
	});
	const queued: Array<Record<string, unknown> | undefined> = [];
	const waiters: Array<(value: Record<string, unknown> | undefined) => void> = [];
	const receive = (value: Record<string, unknown> | undefined) => {
		const waiter = waiters.shift();
		if (waiter) waiter(value);
		else queued.push(value);
	};
	const detach = attachJsonlLineReader(socket, (line) => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) throw new Error("Invalid private record");
		receive(value);
	});
	socket.once("close", () => {
		detach();
		receive(undefined);
	});
	return {
		send: (value: object) => socket.write(`${JSON.stringify(value)}\n`),
		next: () => {
			if (queued.length) return Promise.resolve(queued.shift());
			return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Private frame deadline")), 5_000);
				waiters.push((value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
		},
	};
}

export async function enrollmentFixture() {
	const writer = new SessionEventWriter(() => {});
	const control = new McpPresenterControl(writer, "unused-management-endpoint");
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		control.bootstrap(socket);
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	return {
		control,
		open: () => {
			const socket = connect(address.port, "127.0.0.1");
			sockets.push(socket);
			return enrollmentPeer(socket);
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			control.dispose();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
