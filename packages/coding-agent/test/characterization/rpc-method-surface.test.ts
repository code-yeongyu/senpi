/**
 * X14 (plan row P0-03g): every RPC method the local multi-session host accepts today, with today's
 * acceptance and reply shape. Records travel over a real Unix socket into the same per-connection
 * dispatch `runSocketHost` builds (`socketSink`, `attachJsonlLineReader`, `writer.withConnection` ->
 * `createHostCore(...).handle`), on the in-process registry a `--listen` host selects, with a faux
 * provider and no network.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { corpusRequest, type Opened, TODAY } from "./rpc-method-surface-corpus.ts";

type WireRecord = Record<string, unknown>;

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function startHost() {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-x14-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir);
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET"]) vi.stubEnv(name, undefined);
	vi.stubEnv("PI_RPC_SOCKET", undefined);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs(LEAN_ARGS), cwd, agentDir, appMode: "rpc" },
				{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
			),
			creationModel: { provider: faux.getModel().provider, modelId: "faux-1" },
		},
		writer,
		[],
	);
	const server = createServer((socket) => {
		writer.registerConnection("socket-1", socketSink(socket));
		socket.once("close", () => writer.unregisterConnection("socket-1"));
		socket.once("error", () => writer.unregisterConnection("socket-1"));
		attachJsonlLineReader(socket, (line) => void writer.withConnection("socket-1", () => core.handle(line)));
	});
	const socketPath = join(scratch, "host.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = connect(socketPath);
	await new Promise<void>((resolve) => client.once("connect", resolve));
	const answers = new Map<string, (record: WireRecord) => void>();
	attachJsonlLineReader(client, (line) => {
		const record = JSON.parse(line) as WireRecord;
		if (record.type === "response" && typeof record.id === "string") answers.get(record.id)?.(record);
	});
	let serial = 0;
	return {
		scratch,
		send(command: WireRecord): Promise<WireRecord> {
			const id = `x14-${++serial}`;
			client.write(`${JSON.stringify({ ...command, id })}\n`);
			return new Promise<WireRecord>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no answer to ${String(command.type)}`)), 20_000);
				answers.set(id, (record) => {
					clearTimeout(timer);
					resolve(record);
				});
			});
		},
		async dispose(): Promise<void> {
			await core.router.dispose();
			client.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(scratch, { recursive: true, force: true });
			vi.unstubAllEnvs();
		},
	};
}

function signature(record: WireRecord, method: string, scratch: string): string {
	const envelope = record.command === method ? "" : `command=${String(record.command)}|`;
	const data = record.data;
	if (record.success !== true) {
		const text = String(record.error).split(scratch).join("<tmp>").replace(UUID, "<uuid>");
		return `${envelope}no:${String(record.errorCode ?? "")}:${text}`;
	}
	if (data === undefined) return `${envelope}ok`;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return `${envelope}ok:${typeof data}`;
	return `${envelope}ok{${Object.keys(data).sort().join(",")}}`;
}

async function openFresh(): Promise<Opened> {
	return (await host.send({ type: "open_session" })).data as Opened;
}

let host: Awaited<ReturnType<typeof startHost>>;
beforeAll(async () => {
	host = await startHost();
});
afterAll(async () => {
	await host.dispose();
});

describe("X14: RPC method surface on the local socket", () => {
	it("answers every method in today's handler table with today's answer, and refuses any other method", async () => {
		const actual: Record<string, string> = {};
		const today: Record<string, string> = {};
		for (const [method, row] of Object.entries(TODAY)) {
			const session = await openFresh();
			const { record, answer } = corpusRequest(method, row, session, host.scratch);
			actual[method] = signature(await host.send(record), method, host.scratch);
			today[method] = answer;
		}
		const stray = await host.send({ type: "x14_not_a_method", sessionId: (await openFresh()).sessionId });
		actual.x14_not_a_method = signature(stray, "x14_not_a_method", host.scratch);
		today.x14_not_a_method = "no::Unknown command: x14_not_a_method";
		expect(actual).toEqual(today);
	}, 300_000);
});
