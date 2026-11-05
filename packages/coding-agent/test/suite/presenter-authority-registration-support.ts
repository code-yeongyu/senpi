import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Peer } from "./rpc-public-auth-harness.ts";

const src = resolve(import.meta.dirname, "..", "..", "src");
export const slotModule = pathToFileURL(join(src, "presenter-authority-slot.ts")).href;
const cliModule = pathToFileURL(join(src, "cli.ts")).href;

/** An authority that refuses every attestation: discovery never verifies, and nothing here may admit a presenter. */
const REFUSING_AUTHORITY = `{
	hostAccount: () => "account-under-test",
	verify: async () => ({ ok: false, reason: "attestation_signature" }),
	onAccountChange: () => () => {},
}`;

/** An extension that tries to fill the slot from inside main() and records what happened. */
export function registeringExtension(outcomeFile: string): string {
	return `import { writeFileSync } from "node:fs";
import { registerPresenterAccountAuthority } from ${JSON.stringify(slotModule)};
export default function () {
	let outcome = "registered";
	try {
		registerPresenterAccountAuthority(${REFUSING_AUTHORITY});
	} catch (error) {
		outcome = error instanceof Error ? error.message : String(error);
	}
	writeFileSync(${JSON.stringify(outcomeFile)}, outcome);
}
`;
}

export interface Scratch {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly socket: string;
	/** The host's TMPDIR, where it puts the presenter control socket; see `scratch()`. */
	readonly hostTmp: string;
}

const scratches: string[] = [];
const children: ChildProcess[] = [];

export async function scratch(): Promise<Scratch> {
	const root = await mkdtemp(join(tmpdir(), "senpi-presenter-slot-"));
	scratches.push(root);
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	// The host refuses a key root writable by group or others, so the fixture owns its mode.
	await mkdir(agentDir, { mode: 0o700 });
	// The control socket lands under the host's TMPDIR. Below a deep runner TMPDIR its path passes the 104/108-byte
	// sun_path limit, listen fails and the host correctly starts without a control, so the host gets a short TMPDIR.
	const hostTmp = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "sps-"));
	scratches.push(hostTmp);
	return { root, cwd, agentDir, socket: join(root, "rpc.sock"), hostTmp };
}

export async function cleanup(): Promise<void> {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = once(child, "close");
		child.kill("SIGTERM");
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
		await exited;
		clearTimeout(deadline);
	}
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** The embedding entry: optionally registers, then hands the run to the real CLI, as a distribution does. */
async function entry(at: Scratch, register: boolean): Promise<string> {
	const file = join(at.root, register ? "registering-entry.mjs" : "plain-entry.mjs");
	const registration = register
		? `const { registerPresenterAccountAuthority } = await import(${JSON.stringify(slotModule)});
registerPresenterAccountAuthority(${REFUSING_AUTHORITY});
`
		: "";
	await writeFile(file, `${registration}await import(${JSON.stringify(cliModule)});\n`);
	return file;
}

function environment(at: Scratch): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: at.root,
		TMPDIR: at.hostTmp,
		SENPI_CODING_AGENT_DIR: at.agentDir,
		SENPI_RUNTIME: "node",
		SENPI_OFFLINE: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_RPC_REQUIRE_TOKEN: "0",
		SENPI_RPC_HOST_IDLE_EXIT_MS: "60000",
	};
}

export async function runCli(at: Scratch, register: boolean, args: readonly string[]) {
	const child = spawn(process.execPath, [await entry(at, register), ...args], {
		cwd: at.cwd,
		env: environment(at),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const [code] = await once(child, "close");
	return { code: code as number | null, output };
}

/**
 * Starts a host through an embedding entry and resolves once it reports ready (its own ready line, never a clock).
 * `readyLine` is the bare host's listen line or the supervisor's ready line.
 */
export async function startHost(at: Scratch, register: boolean, args: readonly string[], readyLine: string) {
	const child = spawn(process.execPath, [await entry(at, register), ...args], {
		cwd: at.cwd,
		env: environment(at),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	await new Promise<void>((resolveReady, reject) => {
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(readyLine)) done();
		};
		const onExit = () => done(new Error(`host exited before ${readyLine}:\n${output}`));
		const done = (error?: Error) => {
			child.stderr.off("data", onData);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolveReady();
		};
		child.stderr.on("data", onData);
		child.once("exit", onExit);
	});
	return child;
}

export async function discover(socketPath: string, cwd: string) {
	const peer = await Peer.connect(socketPath, { deadlineMs: 30_000 });
	try {
		const opened = await peer.request({ id: "open", type: "open_session", cwd });
		const sessionId = (opened.data as { sessionId?: unknown } | undefined)?.sessionId ?? opened.sessionId;
		if (typeof sessionId !== "string") throw new Error(`open_session gave no session: ${JSON.stringify(opened)}`);
		return await peer.request({ id: "context", type: "mcp_presenter_context", sessionId, discover: true });
	} finally {
		peer.socket.destroy();
	}
}

export const readOutcome = (file: string): Promise<string> => readFile(file, "utf8");
