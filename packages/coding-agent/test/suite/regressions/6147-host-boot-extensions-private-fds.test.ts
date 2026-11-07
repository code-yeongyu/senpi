import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { type HostCliSandbox, hostCliSandbox, sweepHostCliSandboxes } from "../host-cli-support.ts";
import { peerRecord, send } from "../host-cli-presenter-support.ts";
import { authenticate, Peer } from "../rpc-public-auth-harness.ts";

const sockets: Socket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await sweepHostCliSandboxes();
}, 120_000);

/** A spec whose one extension records each load in `loads` and serves the private `sample-channel`. */
async function bootRecordingSpec(qa: HostCliSandbox): Promise<{ spec: string; loads: string }> {
	const loads = join(qa.root, "loads.log");
	const fixture = join(import.meta.dirname, "../../fixtures/private-fd-extension.ts");
	await writeFile(
		join(qa.specDir, "boot-recorder.ts"),
		[
			`import { appendFileSync } from "node:fs";`,
			`import privateFdExtension from ${JSON.stringify(fixture)};`,
			`export default function bootRecorder(): void {`,
			`\tappendFileSync(${JSON.stringify(loads)}, \`\${Date.now()}\\n\`);`,
			`\tprivateFdExtension();`,
			`}`,
			``,
		].join("\n"),
		{ mode: 0o600 },
	);
	const spec = join(qa.specDir, "launch.json");
	await writeFile(
		spec,
		JSON.stringify({
			spec_version: 1,
			core: { session_runtime: "in-process", multi_session: true, extensions: ["boot-recorder.ts"] },
		}),
		{ mode: 0o600 },
	);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	return { spec, loads };
}

/** `senpi host ensure`, with the launcher's end of `sample-channel` at fd 5 when `withTable`. */
async function ensure(qa: HostCliSandbox, spec: string, withTable: boolean): Promise<Socket | undefined> {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../../../src/cli.ts"),
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
				...(withTable ? { SENPI_PRIVATE_FDS: '{"sample-channel":5}' } : {}),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", withTable ? "pipe" : "ignore"],
		},
	);
	const stdio: readonly unknown[] = child.stdio;
	const channel = stdio[5];
	if (withTable) {
		if (!(channel instanceof Socket)) throw new Error("no private channel");
		sockets.push(channel);
	}
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const [code] = await once(child, "exit", { signal: AbortSignal.timeout(120_000) });
	expect(code, output).toBe(0);
	return channel instanceof Socket ? channel : undefined;
}

function loadCount(loads: string): number {
	return existsSync(loads) ? readFileSync(loads, "utf8").split("\n").filter(Boolean).length : 0;
}

/** A `warm` of the host's default profile (its cwd and context, no kind): the profile a boot load warms. */
async function warmDefault(qa: HostCliSandbox, signal: AbortSignal): Promise<unknown> {
	const peer = await Peer.connect(qa.socket);
	sockets.push(peer.socket);
	await authenticate(peer, qa.agentDir);
	const answered = peerRecord(peer, (record) => record.type === "response" && record.id === "warm", "warm", signal);
	send(peer.socket, { id: "warm", type: "warm" });
	const answer = await answered;
	expect(answer.success, JSON.stringify(answer)).toBe(true);
	return (answer.data as { state?: unknown } | undefined)?.state;
}

// senpi#6147 (omo#12702, omo#12705): a host handed a private-fd table loads its extensions at boot, with no session.
describe.skipIf(process.platform === "win32")("multi-session host boot extension load", () => {
	it("loads extensions once at boot when the launch carries a private-fd table", async ({ signal }) => {
		const qa = await hostCliSandbox("bx");
		const { spec, loads } = await bootRecordingSpec(qa);
		const channel = await ensure(qa, spec, true);
		if (channel === undefined) throw new Error("no private channel");
		// No client has connected and no session exists: only a boot load can claim the channel and answer.
		const echo = once(channel, "data", { signal: AbortSignal.timeout(60_000) });
		channel.write("boot");
		expect(String((await echo)[0])).toBe("echo:boot");
		expect(loadCount(loads)).toBe(1);
		// The boot load is the default-profile warm, so a client's warm reuses it instead of loading again.
		await warmDefault(qa, signal);
		expect(loadCount(loads)).toBe(1);
	}, 240_000);

	it("loads nothing before a session or warm when the launch carries no table", async ({ signal }) => {
		const qa = await hostCliSandbox("bn");
		const { spec, loads } = await bootRecordingSpec(qa);
		await ensure(qa, spec, false);
		expect(loadCount(loads)).toBe(0);
		expect(await warmDefault(qa, signal)).toBe("warmed");
		expect(loadCount(loads)).toBe(1);
	}, 240_000);
});
