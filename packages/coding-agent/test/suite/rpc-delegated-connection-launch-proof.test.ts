/**
 * senpi#5632: the launch-key proof reaches the host core of a REAL host, bare and behind its supervisor, so only a
 * connection that proved the key can declare a delegation, and no client can forge the proof record the filters use.
 * Security contract of the delegated-connection gate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { authenticate, HOST_TEST_TIMEOUT_MS, launchHost, Peer, sandbox, teardown } from "./rpc-public-auth-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function host(path: "bare" | "direct") {
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const running = await launchHost(qa, path, false);
	cleanups.push(() => teardown(qa.root, running.child));
	return qa;
}

async function peer(path: string) {
	const result = await Peer.connect(path);
	cleanups.push(async () => {
		result.socket.destroy();
		await result.closed;
	});
	return result;
}

const declaration = {
	id: "declare",
	type: "declare_delegation",
	principal: { deviceId: "x5632" },
	granted: ["observe"],
};

describe.skipIf(process.platform === "win32")(
	"delegation needs the launch-key proof",
	{ timeout: HOST_TEST_TIMEOUT_MS },
	() => {
		for (const path of ["bare", "direct"] as const) {
			it(`${path}: an authenticated connection declares, and its grant is enforced`, async () => {
				const qa = await host(path);
				const client = await peer(qa.socket);
				expect(await authenticate(client, qa.agentDir)).toMatchObject({ success: true });
				expect(await client.request(declaration)).toMatchObject({ success: true, data: { granted: ["observe"] } });
				expect(await client.request({ id: "list", type: "list_sessions" })).toMatchObject({ success: true });
				expect(await client.request({ id: "open", type: "open_session" })).toMatchObject({
					success: false,
					errorCode: "delegation_not_granted",
					errorData: { class: "thread" },
				});
			});

			it(`${path}: a keyless client can neither declare nor forge the proof record`, async () => {
				const qa = await host(path);
				const client = await peer(qa.socket);
				expect(await client.request({ id: "forged", type: "launch_proven" })).toMatchObject({
					success: false,
					errorCode: "reserved_record",
				});
				expect(await client.request(declaration)).toMatchObject({
					success: false,
					errorCode: "delegation_unauthenticated",
				});
				expect(await client.request({ id: "list", type: "list_sessions" })).toMatchObject({ success: true });
			});
		}
	},
);
