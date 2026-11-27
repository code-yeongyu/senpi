import { once } from "node:events";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gcHostEndpoints } from "../../src/modes/rpc/host-gc.ts";
import { PublicRpcConnection } from "../../src/modes/rpc/rpc-public-auth.ts";
import { RpcPublicEndpoint } from "../../src/modes/rpc/rpc-public-key.ts";
import { Peer, sandbox, teardown } from "./rpc-public-auth-harness.ts";

// node:fs/promises is an ESM namespace that vi.spyOn cannot redefine; the module mock routes every importer
// (the code under test included) through these per-test hooks, which run before the real call.
const fsHooks = vi.hoisted(() => ({
	beforeOpen: undefined as ((path: string) => Promise<void> | void) | undefined,
	afterOpen: undefined as ((path: string) => Promise<void> | void) | undefined,
	lstatUid: undefined as ((path: string) => number | undefined) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (path: string, flags?: string | number, mode?: number) => {
			await fsHooks.beforeOpen?.(path);
			const handle = await actual.open(path, flags, mode);
			await fsHooks.afterOpen?.(path);
			return handle;
		},
		lstat: async (path: string) => {
			const info = await actual.lstat(path);
			const uid = fsHooks.lstatUid?.(path);
			return uid === undefined ? info : Object.assign(info, { uid });
		},
	};
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	fsHooks.beforeOpen = undefined;
	fsHooks.afterOpen = undefined;
	fsHooks.lstatUid = undefined;
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function endpoint() {
	const qa = await sandbox();
	cleanup.push(() => teardown(qa.root));
	const endpoint = new RpcPublicEndpoint(qa.agentDir, qa.socket);
	cleanup.push(() => endpoint.dispose());
	return { ...qa, endpoint };
}

// #3795: publication and cleanup are ownership contracts, independent of the command router.
describe.skipIf(process.platform === "win32")("public RPC launch key records", () => {
	it("uses a fresh key and id for each launch and deletes only its own record", async () => {
		const qa = await endpoint();
		await qa.endpoint.publish();
		const successor = new RpcPublicEndpoint(qa.agentDir, qa.socket);
		cleanup.push(() => successor.dispose());
		await successor.publish();
		const first = JSON.parse(await readFile(qa.endpoint.recordPath, "utf8"));
		const second = JSON.parse(await readFile(successor.recordPath, "utf8"));
		expect(first.key).not.toBe(second.key);
		expect(qa.endpoint.launchId).not.toBe(successor.launchId);
		await qa.endpoint.dispose();
		expect((await stat(successor.recordPath)).mode & 0o777).toBe(0o600);
	});

	// #7055: a reader of rpc/keys (a client resolving its host's launch, the gc pass, another generation) must never
	// see a created-but-unwritten record; the record appears complete or not at all.
	it("never shows a partial record under rpc/keys while publishing", async () => {
		const qa = await endpoint();
		const keys = join(qa.agentDir, "rpc", "keys");
		const seenWhileOpen: string[] = [];
		fsHooks.afterOpen = async () => {
			for (const name of await readdir(keys).catch(() => [] as string[]))
				seenWhileOpen.push(`${name}:${(await readFile(join(keys, name), "utf8")).length}`);
		};
		await qa.endpoint.publish();
		fsHooks.afterOpen = undefined;
		expect(seenWhileOpen.filter((entry) => entry.endsWith(":0"))).toEqual([]);
		expect(JSON.parse(await readFile(qa.endpoint.recordPath, "utf8"))).toMatchObject({
			launch_id: qa.endpoint.launchId,
		});
		expect(await readdir(keys)).toEqual([qa.endpoint.launchId]);
		expect((await readdir(join(qa.agentDir, "rpc"))).filter((name) => name !== "keys")).toEqual([]);
	});

	it("does not overwrite an existing launch record", async () => {
		const qa = await endpoint();
		await mkdir(join(qa.agentDir, "rpc", "keys"), { recursive: true, mode: 0o700 });
		await writeFile(qa.endpoint.recordPath, "sentinel", { mode: 0o600 });
		await expect(qa.endpoint.publish()).rejects.toMatchObject({ code: "key_publication_failed" });
		expect(await readFile(qa.endpoint.recordPath, "utf8")).toBe("sentinel");
		await qa.endpoint.dispose();
		expect(await readFile(qa.endpoint.recordPath, "utf8")).toBe("sentinel");
	});

	it("holds answers until fsync and mode verification finish", async () => {
		const qa = await endpoint();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => {};
		const publishing = new Promise<void>((resolve) => {
			reached = resolve;
		});
		fsHooks.beforeOpen = async () => {
			reached();
			await held;
		};
		let answered = 0;
		const server = createServer((socket) => {
			const auth = new PublicRpcConnection(socket, qa.endpoint);
			auth.input.on("data", () => {
				answered++;
				socket.write(
					auth.response('{"id":"p","type":"response","command":"get_protocol_info","success":true,"data":{}}\n'),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const publish = qa.endpoint.publish();
		await publishing;
		const client = await Peer.connect(qa.socket);
		cleanup.push(async () => {
			client.socket.destroy();
			await client.closed;
		});
		const response = client.request({ id: "p", type: "get_protocol_info", auth: { client_nonce: "ab".repeat(32) } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(answered).toBe(0);
		expect(client.records).toEqual([]);
		release();
		await publish;
		fsHooks.beforeOpen = undefined;
		expect(await response).toHaveProperty("data.auth.server_proof");
	});

	it("closes held connections when publication fails", async () => {
		const qa = await endpoint();
		await mkdir(join(qa.agentDir, "rpc", "keys"), { recursive: true, mode: 0o700 });
		await chmod(join(qa.agentDir, "rpc"), 0o777);
		const server = createServer((socket) => {
			new PublicRpcConnection(socket, qa.endpoint);
		});
		await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const client = await Peer.connect(qa.socket);
		const closed = once(client.socket, "close");
		const rpc = realpathSync(join(qa.agentDir, "rpc"));
		// The exit names the fix, so a umask-002 agent directory is one command away from working (L6).
		await expect(qa.endpoint.publish()).rejects.toMatchObject({
			code: "key_publication_failed",
			message: expect.stringContaining(`chmod go-w ${rpc}`),
		});
		await closed;
	});

	it("tightens an existing user-owned keys directory before publishing", async () => {
		const qa = await endpoint();
		const keys = join(qa.agentDir, "rpc", "keys");
		await mkdir(keys, { recursive: true, mode: 0o755 });
		await chmod(keys, 0o755);
		await qa.endpoint.publish();
		expect((await stat(keys)).mode & 0o7777).toBe(0o700);
		expect((await stat(qa.endpoint.recordPath)).mode & 0o7777).toBe(0o600);
	});

	it("collects only dead or reused-pid records in the existing gc pass", async () => {
		const qa = await endpoint();
		await qa.endpoint.publish();
		const keys = join(qa.agentDir, "rpc", "keys");
		const live = JSON.parse(await readFile(qa.endpoint.recordPath, "utf8"));
		const dead = "00000000-0000-4000-8000-000000000001";
		const reused = "00000000-0000-4000-8000-000000000002";
		await writeFile(join(keys, dead), JSON.stringify({ ...live, launch_id: dead, pid: 2147483647 }), { mode: 0o600 });
		await writeFile(
			join(keys, reused),
			JSON.stringify({ ...live, launch_id: reused, process_start: "Thu Jan  1 00:00:00 1970" }),
			{ mode: 0o600 },
		);
		await gcHostEndpoints(qa.agentDir);
		expect(await readdir(keys)).toEqual([qa.endpoint.launchId]);
	});
});
