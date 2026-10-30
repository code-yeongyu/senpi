import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_SOCKET_IDENTITY_FILE, writeSocketIdentityFile } from "../../src/modes/rpc/socket-ownership.ts";
import {
	authenticate,
	challenge,
	HOST_TEST_TIMEOUT_MS,
	launchHost,
	Peer,
	sandbox,
	teardown,
} from "./rpc-public-auth-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * What a tool running inside a supervised host hands a nested `--mode rpc --listen` it starts: the parent host's
 * environment, including the supervisor-watch variables. None of it carries the internal key, so the nested host is
 * a public endpoint and must authenticate like any other (senpi#3815 review L4).
 */
async function nestedHost(strict: boolean) {
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const scratch = join(qa.root, "parent-scratch");
	await mkdir(scratch, { mode: 0o700 });
	// A live parent supervisor has published its public-socket token in its scratch dir; without it the nested host would
	// wait out SOCKET_IDENTITY_WAIT_MS (30 s) for that token before it reports ready.
	await writeSocketIdentityFile(join(scratch, PUBLIC_SOCKET_IDENTITY_FILE), { dev: 1, ino: 1 });
	const running = await launchHost(qa, "bare", strict, {
		SENPI_RPC_HOST_WATCH_PPID: String(process.pid),
		SENPI_RPC_HOST_PUBLIC_SOCKET: join(qa.root, "parent.sock"),
		SENPI_RPC_HOST_SCRATCH_DIR: scratch,
		SENPI_RPC_HOST_INSTANCE_ID: "parent-instance",
	});
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

describe.skipIf(process.platform === "win32")(
	"nested host with the parent host's environment",
	{ timeout: HOST_TEST_TIMEOUT_MS },
	() => {
		it("enforces public auth: offers the challenge and refuses an unauthenticated session command", async () => {
			const host = await nestedHost(true);
			const prober = await peer(host.socket);
			const { auth } = await challenge(prober);
			expect(auth.server_proof).toMatch(/^[a-f0-9]{64}$/);
			const keyless = await peer(host.socket);
			expect(await keyless.request({ id: "list", type: "list_sessions" })).toMatchObject({
				success: false,
				errorCode: "auth_required",
			});
			await keyless.closed;
		});

		it("in grace, offers the challenge and serves a keyless client with one deprecation line", async () => {
			const host = await nestedHost(false);
			const prober = await peer(host.socket);
			expect(await authenticate(prober, host.agentDir)).toMatchObject({ success: true });
			const keyless = await peer(host.socket);
			expect(await keyless.request({ id: "list", type: "list_sessions" })).toMatchObject({ success: true });
			keyless.socket.destroy();
			await keyless.closed;
			const exited = once(host.child, "close");
			host.child.kill("SIGTERM");
			await exited;
			expect(
				host
					.stderr()
					.split("\n")
					.filter((line) => line.includes("did not prove the endpoint key")),
			).toHaveLength(1);
		});
	},
);
