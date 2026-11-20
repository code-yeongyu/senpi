import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { vi } from "vitest";
import { createSessionPathReservations, reservationFile } from "../../src/modes/rpc/host-reservations.ts";
import { HOST_GENERATION_ENV } from "../../src/modes/rpc/host-identity-env.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { listenForSuccessor } from "../../src/modes/rpc/predecessor-endpoint.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { readProcessStartTime } from "../../src/utils/process-identity.ts";
import { waitForPidGone } from "../helpers/spawned-host-reaper.ts";
import { inProcessRuntimeFactory } from "./rpc-inprocess-host-support.ts";

export type WireRecord = Readonly<Record<string, unknown>>;
export type Cleanups = Array<() => Promise<void>>;
/** How the fake predecessor answers one request after its identity is proven; unhandled types go unanswered. */
export type PredecessorHandlers = Partial<Record<string, (stream: Duplex, request: WireRecord) => void>>;

export function answer(stream: Duplex, request: WireRecord, data: WireRecord): void {
	stream.write(serializeJsonLine({ id: request.id, type: "response", command: request.type, success: true, data }));
}

/** The draining predecessor `pred`: a real authenticated route endpoint whose answers the test scripts. */
export async function fakePredecessor(
	cleanups: Cleanups,
	host: { readonly agentDir: string; readonly daemonDir: string },
	handlers: PredecessorHandlers,
): Promise<{ readonly kill: () => void }> {
	const generationDir = join(host.daemonDir, "generations", "pred");
	const childDir = join(host.daemonDir, "..", "p");
	await mkdir(generationDir, { recursive: true, mode: 0o700 });
	await mkdir(childDir, { recursive: true, mode: 0o700 });
	const streams: Duplex[] = [];
	const close = await listenForSuccessor(host.agentDir, join(childDir, "child.sock"), generationDir, (stream) => {
		streams.push(stream);
		attachJsonlLineReader(stream, (line) => {
			const request = JSON.parse(line) as WireRecord;
			if (request.type === "get_protocol_info") answer(stream, request, { instanceId: "pred", generation: 0 });
			else if (typeof request.type === "string") handlers[request.type]?.(stream, request);
		});
	});
	const kill = () => {
		for (const stream of streams.splice(0)) stream.destroy();
	};
	cleanups.push(async () => {
		kill();
		await close();
	});
	return { kill };
}

/**
 * Generation 1 (`succ`) while generation 0 (`pred`) drains and still runs `held.jsonl` under a standing
 * strict-transfer claim; `pred`'s endpoint is started separately with `fakePredecessor`.
 */
export async function successorWithPredecessorClaim(
	cleanups: Cleanups,
	options: { readonly closeGraceMs?: number } = {},
) {
	vi.stubEnv(HOST_GENERATION_ENV, "1");
	const root = realpathSync(await mkdtemp(join(tmpdir(), "s7098-route-")));
	cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
	const agentDir = join(root, "a");
	const daemonDir = join(root, "d");
	const reservations = join(daemonDir, "reservations");
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await mkdir(reservations, { recursive: true, mode: 0o700 });
	await writeFile(
		join(daemonDir, "host.pid"),
		`${JSON.stringify({ layout: 2, instance_id: "succ", generation_dir: "generations/succ" })}\n`,
		{ mode: 0o600 },
	);
	const { createRuntime } = inProcessRuntimeFactory();
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime,
		closeGraceMs: options.closeGraceMs,
		pathReservations: createSessionPathReservations({ daemonDir, instanceId: "succ" }),
	});
	const writer = new SessionEventWriter(() => {});
	const delivered: WireRecord[] = [];
	writer.registerConnection("client", {
		writeRaw: (line) => delivered.push(JSON.parse(line) as WireRecord),
		waitForBackpressure: async () => {},
	});
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: root, agentDir, hostContext: { host_instance: "succ" } },
		async () => ({ handle: async () => {}, dispose: async () => {}, cancelPendingExtensionUiRequests: () => {} }),
		{},
		{ handoverParkedDir: daemonDir },
	);
	cleanups.push(() => router.dispose());
	router.setInheritedHandover({ pending: 0, predecessorDraining: false });
	const send = async (command: RpcCommand & { id: string }): Promise<RpcResponse | WireRecord | undefined> => {
		const direct = await writer.withConnection("client", () => router.handle(command));
		await writer.flush();
		return direct ?? delivered.findLast((record) => record.id === command.id);
	};
	const heldPath = join(root, "held.jsonl");
	return {
		agentDir,
		daemonDir,
		root,
		heldPath,
		registry,
		router,
		send,
		list: () => send({ type: "list_sessions", id: "list" }),
		/** `pred` holds `held.jsonl`: the file exists and its claim stands while a live process owns it. */
		async predecessorHolds(): Promise<void> {
			const owner = await strangerProcess(cleanups);
			await writeFile(
				heldPath,
				`${JSON.stringify({ type: "session", version: 3, id: "70980000-0000-4000-8000-000000000002", timestamp: new Date(0).toISOString(), cwd: root })}\n`,
			);
			await writeFile(
				reservationFile(reservations, heldPath),
				`${JSON.stringify({ instanceId: "pred", ...owner, sessionPath: heldPath, attached: false, strict_transfer: true })}\n`,
				{ mode: 0o600 },
			);
			router.setInheritedHandover({ pending: 0, predecessorDraining: true });
		},
	};
}

/** A live process the claim names: a claim naming this test's own pid is this host's, not a predecessor's. */
async function strangerProcess(cleanups: Cleanups): Promise<{ pid: number; processStartTime: string | null }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not spawn the predecessor's stand-in process");
	child.unref();
	cleanups.push(async () => {
		child.kill("SIGKILL");
		await waitForPidGone(pid, 20_000);
	});
	return { pid, processStartTime: (await readProcessStartTime(pid).catch(() => null)) ?? null };
}

/** Drives the virtual clock until `settled` resolves, without waiting real time; false when it never did. */
export async function advanceUntil(settled: Promise<unknown>, stepMs: number, turns = 200): Promise<boolean> {
	let done = false;
	void settled.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let turn = 0; turn < turns && !done; turn++) {
		vi.advanceTimersByTime(stepMs);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return done;
}
