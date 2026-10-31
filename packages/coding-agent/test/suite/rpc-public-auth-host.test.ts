import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { chmod, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import {
	authenticate,
	challenge,
	HOST_TEST_TIMEOUT_MS,
	launchHost,
	Peer,
	proof,
	sandbox,
	teardown,
} from "./rpc-public-auth-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function host(path: "bare" | "direct" | "ensured", strict = true) {
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const running = await launchHost(qa, path, strict);
	cleanups.push(() => teardown(qa.root, running.child));
	return { ...qa, ...running };
}
async function peer(path: string) {
	const result = await Peer.connect(path);
	cleanups.push(async () => {
		result.socket.destroy();
		await result.closed;
	});
	return result;
}

// #3795: authentication must guard the actual public listener, not only a helper.
describe.skipIf(process.platform === "win32")("public POSIX authentication", { timeout: HOST_TEST_TIMEOUT_MS }, () => {
	for (const path of ["bare", "direct", "ensured"] as const) {
		it(`${path}: refuses keyless commands under enforcement`, async () => {
			const qa = await host(path);
			const client = await peer(qa.socket);
			const reply = await client.request({ id: "list", type: "list_sessions" });
			expect(reply).toMatchObject({ success: false, errorCode: "auth_required" });
			await client.closed;
		});

		it(`${path}: emits auth_failed before close and never executes a later frame`, async () => {
			const qa = await host(path);
			const client = await peer(qa.socket);
			await challenge(client);
			const refused = client.waitFor((record) => record.id === "bad");
			client.socket.write(
				`${JSON.stringify({ id: "bad", type: "authenticate", client_proof: "00".repeat(32) })}\n` +
					`${JSON.stringify({ id: "later", type: "open_session", cwd: qa.root, retain_on_disconnect: true })}\n`,
			);
			expect(await refused).toMatchObject({ success: false, errorCode: "auth_failed" });
			await client.closed;
			expect(client.records.some((record) => record.id === "later")).toBe(false);
			const verifier = await peer(qa.socket);
			await authenticate(verifier, qa.agentDir);
			expect(await verifier.request({ id: "verify", type: "list_sessions" })).toMatchObject({
				success: true,
				data: { sessions: [] },
			});
		});

		it(`${path}: publishes a private per-launch record and admits an authenticated client`, async () => {
			const qa = await host(path);
			const client = await peer(qa.socket);
			expect(await authenticate(client, qa.agentDir)).toMatchObject({ success: true });
			expect(await client.request({ id: "list", type: "list_sessions" })).toMatchObject({ success: true });
			const keys = join(qa.agentDir, "rpc", "keys");
			expect((await stat(keys)).mode & 0o777).toBe(0o700);
			const entries = await readdir(keys);
			expect(entries).toHaveLength(1);
			const file = join(keys, entries[0]);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			const record = JSON.parse(await readFile(file, "utf8"));
			expect(record).toMatchObject({
				key: expect.stringMatching(/^[a-f0-9]{64}$/),
				pid: expect.any(Number),
				version: 1,
				launch_id: entries[0],
				process_start: expect.any(String),
				endpoint: qa.socket,
				created_at: expect.any(String),
			});
		});
	}

	it("starts and authenticates with a normal recursive-mkdir 0755 agent directory", async () => {
		const qa = await sandbox();
		cleanups.push(() => teardown(qa.root));
		await rm(qa.agentDir, { recursive: true });
		mkdirSync(qa.agentDir, { recursive: true });
		await chmod(qa.agentDir, 0o755);
		mkdirSync(join(qa.agentDir, "rpc"), { recursive: true });
		await chmod(join(qa.agentDir, "rpc"), 0o755);
		const running = await launchHost(qa, "bare");
		cleanups.push(() => teardown(qa.root, running.child));
		const client = new RpcClient({ socketPath: qa.socket, keyRoot: qa.agentDir });
		cleanups.push(() => client.stop());
		await client.start();
		expect(await client.listSessions()).toEqual([]);
		expect((await stat(qa.agentDir)).mode & 0o7777).toBe(0o755);
		expect((await stat(join(qa.agentDir, "rpc"))).mode & 0o7777).toBe(0o755);
		expect((await stat(join(qa.agentDir, "rpc", "keys"))).mode & 0o7777).toBe(0o700);
	});

	it("serves keyless grace traffic with exactly one deprecation line", async () => {
		const qa = await host("bare", false);
		const client = await peer(qa.socket);
		await client.request({ id: "a", type: "list_sessions" });
		await client.request({ id: "b", type: "list_sessions" });
		client.socket.destroy();
		await client.closed;
		const drained = once(qa.child, "close");
		qa.child.kill("SIGTERM");
		await drained;
		expect(
			qa
				.stderr()
				.split("\n")
				.filter((line) => line.includes("did not prove the endpoint key")),
		).toEqual([
			`senpi rpc host: served a client that did not prove the endpoint key on ${qa.socket} (deprecated, refused from the next release; see docs/rpc.md#authentication)`,
		]);
	});

	it("grace: serves a keyless first frame over 8 KiB with one deprecation line and no drop", async () => {
		const qa = await host("bare", false);
		const client = await peer(qa.socket);
		const reply = await client.request({ id: "big", type: "list_sessions", padding: "x".repeat(9000) });
		expect(reply).toMatchObject({ id: "big", type: "response" });
		client.socket.destroy();
		await client.closed;
		const drained = once(qa.child, "close");
		qa.child.kill("SIGTERM");
		await drained;
		const lines = qa.stderr().split("\n");
		expect(lines.filter((line) => line.includes("did not prove the endpoint key"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("dropped an unauthenticated connection"))).toEqual([]);
	});

	it("authenticates fragmented and coalesced frames", async () => {
		const qa = await host("bare");
		const client = await peer(qa.socket);
		const nonce = randomBytes(32).toString("hex");
		const request = JSON.stringify({
			id: "p",
			type: "get_protocol_info",
			observe: true,
			auth: { client_nonce: nonce },
		});
		const response = client.waitFor((record) => record.id === "p");
		client.socket.write(request.slice(0, 23));
		client.socket.write(`${request.slice(23)}\n`);
		const auth = ((await response).data as { auth: { launch_id: string; server_nonce: string } }).auth;
		const record = JSON.parse(await readFile(join(qa.agentDir, "rpc", "keys", auth.launch_id), "utf8"));
		const answer = client.waitFor((value) => value.id === "list");
		client.socket.write(
			`${JSON.stringify({
				id: "a",
				type: "authenticate",
				client_proof: proof(
					Buffer.from(record.key, "hex"),
					"senpi-rpc-client",
					auth.launch_id,
					auth.server_nonce,
					nonce,
				),
			})}\n${JSON.stringify({ id: "list", type: "list_sessions" })}\n`,
		);
		expect(await answer).toMatchObject({ success: true });
	});

	it("drops an oversized first frame without executing it", async () => {
		const qa = await host("bare");
		const client = await peer(qa.socket);
		client.socket.write(`{"id":"large","type":"get_protocol_info","padding":"${"x".repeat(8192)}`);
		await client.closed;
		expect(client.records).toEqual([]);
	});

	it("drops an incomplete first frame at the handshake deadline", async () => {
		const qa = await host("bare");
		const client = await peer(qa.socket);
		client.socket.write('{"type":');
		await client.closed;
		expect(client.records).toEqual([]);
	});

	it("uses a separate key root without changing the client profile", async () => {
		const qa = await host("bare");
		const profile = await sandbox();
		cleanups.push(() => teardown(profile.root));
		const settings = {
			skills: ["./profile-b-skills"],
			mcpServers: { fixture: { command: "fixture", env: { FIXTURE_PROFILE: "B" } } },
			defaultProvider: "profile-b",
		};
		await writeFile(join(profile.agentDir, "settings.json"), JSON.stringify(settings));
		vi.stubEnv("SENPI_CODING_AGENT_DIR", profile.agentDir);
		const options = {
			socketPath: qa.socket,
			keyRoot: qa.agentDir,
			env: { SENPI_CODING_AGENT_DIR: profile.agentDir },
		};
		const client = new RpcClient(options);
		cleanups.push(() => client.stop());
		await client.start();
		expect(await client.listSessions()).toEqual([]);
		expect(getAgentDir()).toBe(profile.agentDir);
		expect(JSON.parse(await readFile(join(getAgentDir(), "settings.json"), "utf8"))).toEqual(settings);
	});

	it("deletes only its own launch record on normal shutdown", async () => {
		const qa = await host("bare");
		const client = await peer(qa.socket);
		const { auth } = await challenge(client);
		client.socket.destroy();
		await client.closed;
		const exited = once(qa.child, "exit");
		qa.child.kill("SIGTERM");
		await exited;
		expect(await readdir(join(qa.agentDir, "rpc", "keys"))).not.toContain(auth.launch_id);
	});
});
