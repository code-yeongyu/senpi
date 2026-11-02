import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { holdProtocolInfo } from "../../src/modes/rpc/host-probe.ts";
import { requestOnSocket } from "../../src/modes/rpc/host-socket-request.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { proof, sandbox, teardown, type Wire } from "./rpc-public-auth-harness.ts";

// node:fs/promises is an ESM namespace that vi.spyOn cannot redefine; the module mock routes every importer
// (the code under test included) through these per-test hooks, which run before the real call.
const fsHooks = vi.hoisted(() => ({
	beforeOpen: undefined as ((path: string) => Promise<void> | void) | undefined,
	lstatUid: undefined as ((path: string) => number | undefined) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (path: string, flags?: string | number, mode?: number) => {
			await fsHooks.beforeOpen?.(path);
			return actual.open(path, flags, mode);
		},
		lstat: async (path: string) => {
			const info = await actual.lstat(path);
			const uid = fsHooks.lstatUid?.(path);
			return uid === undefined ? info : Object.assign(info, { uid });
		},
	};
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	fsHooks.beforeOpen = undefined;
	fsHooks.lstatUid = undefined;
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listener(handle: (request: Wire, socket: Socket) => void) {
	const qa = await sandbox();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		attachJsonlLineReader(socket, (line) => handle(JSON.parse(line), socket));
	});
	await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await teardown(qa.root);
	});
	return { ...qa, server };
}

function answer(socket: Socket, request: Wire, fields: Wire) {
	socket.write(
		`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, ...fields })}\n`,
	);
}

// #3795: wire-level identity failures must stop a first-party client before any command.
describe.skipIf(process.platform === "win32")("public RPC client verification", () => {
	for (const state of [
		"valid",
		"missing",
		"wrong-proof",
		"symlink",
		"mode",
		"size",
		"directory",
		"root-0755",
		"root-mode",
		"root-other-write",
		"root-owner",
		"rpc-mode",
		"rpc-world-write",
		"version",
		"launch-id",
		"owner",
		"unreadable",
	] as const) {
		it(`handles the ${state} key-record state`, async () => {
			const launchId = randomUUID();
			const key = randomBytes(32);
			const serverNonce = randomBytes(32).toString("hex");
			const requests: Wire[] = [];
			const qa = await listener((request, socket) => {
				requests.push(request);
				if (request.type === "get_protocol_info") {
					const auth = request.auth as { client_nonce: string } | undefined;
					answer(socket, request, {
						data: {
							capabilities: ["socket_auth"],
							auth: {
								launch_id: launchId,
								server_nonce: serverNonce,
								server_proof:
									state === "wrong-proof"
										? "00".repeat(32)
										: proof(key, "senpi-rpc-server", launchId, auth?.client_nonce ?? "", serverNonce),
							},
						},
					});
				} else if (request.type === "authenticate") {
					const first = requests[0].auth as { client_nonce: string };
					expect(request.client_proof).toBe(
						proof(key, "senpi-rpc-client", launchId, serverNonce, first.client_nonce),
					);
					answer(socket, request, { data: {} });
				} else answer(socket, request, { data: { sessions: [] } });
			});
			const keys = join(qa.agentDir, "rpc", "keys");
			await mkdir(keys, { recursive: true, mode: 0o700 });
			await chmod(join(qa.agentDir, "rpc"), 0o700);
			const record = join(keys, launchId);
			if (state !== "missing") {
				await writeFile(
					record,
					JSON.stringify({
						version: state === "version" ? 2 : 1,
						launch_id: state === "launch-id" ? randomUUID() : launchId,
						key: state === "size" ? "ab" : key.toString("hex"),
					}),
					{ mode: 0o600 },
				);
			}
			if (state === "symlink") {
				const target = join(qa.root, "key");
				await writeFile(target, JSON.stringify({ version: 1, launch_id: launchId, key: key.toString("hex") }), {
					mode: 0o600,
				});
				await unlink(record);
				await symlink(target, record);
			}
			if (state === "mode") await chmod(record, 0o644);
			if (state === "directory") await chmod(keys, 0o755);
			// Key root rule (#3795): realpath'd, user-owned, no group/other write; 0755 is accepted.
			if (state === "root-0755") {
				await chmod(qa.agentDir, 0o755);
				await chmod(join(qa.agentDir, "rpc"), 0o755);
			}
			if (state === "root-mode") await chmod(qa.agentDir, 0o775);
			if (state === "root-other-write") await chmod(qa.agentDir, 0o757);
			if (state === "rpc-mode") await chmod(join(qa.agentDir, "rpc"), 0o775);
			if (state === "rpc-world-write") await chmod(join(qa.agentDir, "rpc"), 0o777);
			if (state === "root-owner") {
				const root = realpathSync(qa.agentDir);
				fsHooks.lstatUid = (path) => (path === root ? (process.getuid?.() ?? 0) + 1 : undefined);
			}
			if (state === "unreadable") {
				fsHooks.beforeOpen = (path) => {
					if (path === record) throw Object.assign(new Error("denied"), { code: "EACCES" });
				};
			}
			if (state === "owner") {
				fsHooks.lstatUid = (path) => (path === keys ? (process.getuid?.() ?? 0) + 1 : undefined);
			}
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const options = { socketPath: qa.socket, keyRoot: qa.agentDir };
			const client = new RpcClient(options);
			cleanups.push(() => client.stop());
			if (state === "valid" || state === "missing" || state === "root-0755") {
				await client.start();
				expect(await client.listSessions()).toEqual([]);
				expect(requests.some((request) => request.type === "authenticate")).toBe(state !== "missing");
				if (state === "missing")
					expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(
						`senpi rpc client: no key record for launch ${launchId} under ${qa.agentDir}; continuing unauthenticated (refused from the next release; set SENPI_RPC_KEY_ROOT to the host's agent dir)`,
					);
			} else {
				await expect(client.start()).rejects.toMatchObject({
					code: state === "wrong-proof" ? "host_identity_unproven" : "unsafe_key_record",
				});
				expect(requests.map((request) => request.type)).toEqual(["get_protocol_info"]);
			}
		});
	}

	it("preserves observer and ensure-hold semantics against the real base router", async () => {
		const qa = await sandbox();
		const occupancy = new ClientOccupancy(() => {});
		const sockets = new Set<Socket>();
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			occupancy.admit(socket);
			socket.once("close", () => {
				occupancy.release(socket);
				sockets.delete(socket);
			});
			const writer = new SessionEventWriter((text) => socket.write(text));
			const { handle } = createHostCore(
				{
					agentDir: qa.agentDir,
					cwd: qa.root,
					createRuntime: async () => {
						throw new Error("no session expected");
					},
				},
				writer,
			);
			attachJsonlLineReader(socket, (line) => void handle(line));
		});
		await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await teardown(qa.root);
		});
		const options = { socketPath: qa.socket, keyRoot: qa.agentDir };
		const client = new RpcClient(options);
		cleanups.push(() => client.stop());
		await client.start();
		expect(occupancy.attachedCount).toBe(0);
		const held = await holdProtocolInfo(qa.socket, 5000);
		expect(held?.info.protocolVersion).toBe(1);
		expect(occupancy.attachedCount).toBe(1);
		held?.hold.release();
		await client.stop();
	});

	it("preserves the caller's first protocol fields and authenticates one-shot probes", async () => {
		const requests: Wire[] = [];
		const qa = await listener((request, socket) => {
			requests.push(request);
			answer(socket, request, { data: { protocolVersion: 1 } });
		});
		const options = { keyRoot: qa.agentDir };
		await requestOnSocket(
			qa.socket,
			{ type: "get_protocol_info", observe: false, origin_host_instance: "parent" },
			5000,
			options,
		);
		expect(requests[0]).toMatchObject({
			type: "get_protocol_info",
			observe: false,
			origin_host_instance: "parent",
			auth: { client_nonce: expect.stringMatching(/^[a-f0-9]{64}$/) },
		});
	});
});
