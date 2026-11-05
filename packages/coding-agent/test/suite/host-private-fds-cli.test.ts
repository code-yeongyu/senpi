import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostCliSandbox, runHostCli, sweepHostCliSandboxes } from "./host-cli-support.ts";
import { authenticate, Peer } from "./rpc-public-auth-harness.ts";
import { acknowledgedRequest } from "./host-cli-presenter-support.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";

const sockets: Socket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await sweepHostCliSandboxes();
}, 120_000);

async function launch(qa: Awaited<ReturnType<typeof hostCliSandbox>>, spec: string) {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../../src/cli.ts"),
			"host",
			"ensure",
			"--socket",
			qa.socket,
			"--launch-spec",
			spec,
			"--json",
		],
		{
			env: {
				PATH: process.env.PATH,
				HOME: qa.root,
				TMPDIR: process.env.TMPDIR,
				SENPI_CODING_AGENT_DIR: qa.agentDir,
				SENPI_RUNTIME: "bun",
				SENPI_PRIVATE_FDS: '{"sample-channel":5}',
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
		},
	);
	const stdio: readonly unknown[] = child.stdio;
	const channel = stdio[5];
	if (!(channel instanceof Socket)) throw new Error("no private channel");
	sockets.push(channel);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const [code] = await once(child, "exit", { signal: AbortSignal.timeout(120_000) });
	expect(code, `${stderr}\n${stdout}`).toBe(0);
	return { channel, payload: JSON.parse(stdout) };
}

// #4749: the public CLI, real ensure, real supervisor and registered extension all participate.
describe.skipIf(process.platform === "win32")("private descriptor host CLI deployment", () => {
	it("survives ensure exit, refuses reuse injection, and replaces only with a fresh channel", async () => {
		const qa = await hostCliSandbox("pf");
		writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
		const spec = join(qa.specDir, "launch.json");
		// Launch-spec extensions must resolve inside the spec directory; re-export the shared fixture.
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-extension.ts");
		await writeFile(
			join(qa.specDir, "private-fd-extension.ts"),
			`export { default } from ${JSON.stringify(fixture)};\n`,
			{ mode: 0o600 },
		);
		await writeFile(
			spec,
			JSON.stringify({
				spec_version: 1,
				core: { session_runtime: "in-process", multi_session: true, extensions: ["private-fd-extension.ts"] },
			}),
			{ mode: 0o600 },
		);
		const first = await launch(qa, spec);
		expect(first.payload.reused).toBe(false);
		const peer = await Peer.connect(qa.socket);
		sockets.push(peer.socket);
		await authenticate(peer, qa.agentDir);
		await acknowledgedRequest(peer, {
			id: "open",
			type: "open_session",
			cwd: qa.root,
			provider: MOCK_PROVIDER,
			modelId: MOCK_MODEL,
		});
		const received = once(first.channel, "data", { signal: AbortSignal.timeout(15_000) });
		first.channel.write("inspect");
		expect(JSON.parse(String((await received)[0]))).toEqual({ childExit: 0 });

		const reused = await launch(qa, spec);
		expect(reused.payload.reused).toBe(true);
		reused.channel.destroy();
		const echo = once(first.channel, "data", { signal: AbortSignal.timeout(15_000) });
		first.channel.write("old");
		expect(String((await echo)[0])).toBe("echo:old");
		peer.socket.destroy();
		const oldClosed = once(first.channel, "close", { signal: AbortSignal.timeout(30_000) });
		expect((await runHostCli(qa, ["stop", "--force", "--json"])).exitCode).toBe(0);
		await oldClosed;

		const fresh = await launch(qa, spec);
		expect(fresh.payload.reused).toBe(false);
		const freshPeer = await Peer.connect(qa.socket);
		sockets.push(freshPeer.socket);
		await authenticate(freshPeer, qa.agentDir);
		await acknowledgedRequest(freshPeer, {
			id: "new",
			type: "open_session",
			cwd: qa.root,
			provider: MOCK_PROVIDER,
			modelId: MOCK_MODEL,
		});
		const freshEcho = once(fresh.channel, "data", { signal: AbortSignal.timeout(15_000) });
		fresh.channel.write("new");
		expect(String((await freshEcho)[0])).toBe("echo:new");
		expect(first.channel.destroyed).toBe(true);
	}, 240_000);
});
