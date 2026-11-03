/**
 * A headless host core (`headlessHostOptions` + `createHostCore`, real CLI runtimes on a faux provider) with a presence
 * binding over a memory DurableStore, driven by the plans of presence-script-support.ts. A session opened in
 * `handCwd(name)` runs every tool call on the fake hand `name`; one opened in `fusedCwd` runs them in process.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { parseArgs } from "../../src/cli/args.ts";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { headlessHostOptions } from "../../src/modes/headless/headless-host.ts";
import { type HeadlessPresence, openHeadlessPresence } from "../../src/modes/headless/presence.ts";
import { createPresenceLedger } from "../../src/modes/headless/presence-ledger.ts";
import type { RpcSessionPresence } from "../../src/modes/rpc/rpc-host-response-types.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { bounded, createToolScript, toolResult } from "./presence-script-support.ts";

export const OWNER = "owner-1";
type Wire = Record<string, unknown>;

export async function startPresenceRig(options: { readonly presence?: boolean } = {}) {
	const scratch = await mkdtemp(join(tmpdir(), "headless-presence-"));
	const agentDir = join(scratch, "agent");
	const fusedCwd = join(scratch, "fused");
	const handCwds = new Map(["hand-1", "hand-2"].map((hand) => [hand, join(scratch, hand)]));
	for (const dir of [agentDir, fusedCwd, ...handCwds.values()]) await mkdir(dir);

	const tools = createToolScript();
	const ends = new Map<string, number>();
	const endWaiters = new Set<() => void>();
	const faux = fauxProvider({ models: [{ id: "faux-presence" }] });
	faux.setResponses(Array.from({ length: 64 }, () => tools.script));
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await modelRuntime.registerNativeProvider(faux.provider);
	const parsed = parseArgs([
		...["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"],
		...["--provider", model.provider, "--model", model.id, "--api-key", "faux-key"],
	]);
	const cliRuntime = createCliRuntimeFactory(
		{ parsed, cwd: fusedCwd, agentDir, appMode: "rpc" },
		{
			modelRuntime,
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					pi.registerTool({
						name: "barrier",
						label: "barrier",
						description: "Holds the turn until the test releases it.",
						parameters: Type.Object({}),
						execute: async () => toolResult(await tools.runTool("barrier", "local")),
					});
				},
			],
		},
	);
	const hands = new WeakMap<object, readonly string[]>();
	const createRuntime: CreateAgentSessionRuntimeFactory = async (input) => {
		const runtime = await cliRuntime(input);
		const { session } = runtime;
		const hand = [...handCwds].find(([, dir]) => dir === input.cwd)?.[0];
		if (hand !== undefined) session.agent.toolHost = tools.handHost(hand);
		hands.set(runtime, hand === undefined ? [] : [hand]);
		session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			ends.set(session.sessionId, (ends.get(session.sessionId) ?? 0) + 1);
			for (const wake of [...endWaiters]) wake();
		});
		return runtime;
	};

	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium);
	await store.claim(0, 1);
	const ledger = createPresenceLedger({ store, epoch: 1, admission: createAdmissionLine() });
	const presence: HeadlessPresence = await openHeadlessPresence({ ledger, placement: OWNER });
	const records: Wire[] = [];
	const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
	const core = createHostCore(
		headlessHostOptions({
			agentDir,
			cwd: fusedCwd,
			createRuntime,
			listen: "stdio://",
			...(options.presence === false
				? {}
				: { presence: { presence, handsOf: (runtime) => hands.get(runtime) ?? [] } }),
		}),
		writer,
		[],
		{ closeGraceMs: 100 },
	);
	for (const cwd of [fusedCwd, ...handCwds.values()]) {
		const warmed = await core.router.handle({ type: "warm", cwd });
		if (warmed?.success !== true) throw new Error(`fixture warm failed: ${JSON.stringify(warmed)}`);
	}

	const send = (connection: string, command: Wire): Promise<void> =>
		writer.withConnection(connection, () => core.handle(JSON.stringify(command)));
	const request = async (connection: string, command: Wire): Promise<Wire> => {
		const id = `${String(command.type)}-${randomUUID()}`;
		await send(connection, { ...command, id });
		await writer.flush();
		const found = records.find((record) => record.type === "response" && record.id === id);
		if (found?.success !== true) throw new Error(`${String(command.type)} failed: ${JSON.stringify(found)}`);
		return Object(found.data);
	};

	return {
		presence,
		requests: tools.requests,
		handRuns: tools.handRuns,
		fusedCwd,
		handCwd: (hand: string) => handCwds.get(hand) ?? fusedCwd,
		get barrierStarted() {
			return tools.barrierStarted;
		},
		releaseBarrier: tools.releaseBarrier,
		storeRecords: async () => (await store.scanRecords()).map(({ kind, data }) => ({ kind, data })),
		connect: (connection: string) =>
			writer.registerConnection(connection, {
				writeRaw: (line) => records.push(JSON.parse(line)),
				waitForBackpressure: () => Promise.resolve(),
			}),
		detach: async (connection: string) => {
			writer.unregisterConnection(connection);
			await core.router.releaseConnection(connection);
		},
		newSessionFile: async (cwd: string) => {
			const file = join(scratch, `${randomUUID()}.jsonl`);
			const header = { type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date(0).toISOString() };
			await writeFile(file, `${JSON.stringify(header)}\n`);
			return file;
		},
		open: (connection: string, cwd: string, sessionPath?: string) =>
			request(connection, { type: "open_session", cwd, ...(sessionPath === undefined ? {} : { sessionPath }) }),
		list: async (connection: string): Promise<readonly Wire[]> => {
			const { sessions } = await request(connection, { type: "list_sessions" });
			return Array.isArray(sessions) ? sessions : [];
		},
		/** Sends a prompt without waiting for its turn; the returned promise settles when the host has handled it. */
		prompt: (connection: string, sessionId: string, label: string, plan: readonly string[]) =>
			send(connection, {
				type: "prompt",
				id: `prompt-${randomUUID()}`,
				sessionId,
				message: tools.prompt(label, plan),
			}),
		turnEnded: (sessionId: string) =>
			bounded(
				new Promise<void>((resolve) => {
					const check = (): void => {
						if ((ends.get(sessionId) ?? 0) === 0) return;
						endWaiters.delete(check);
						resolve();
					};
					endWaiters.add(check);
					check();
				}),
				`agent_end of ${sessionId}`,
			),
		untilView: (sessionId: string, predicate: (view: RpcSessionPresence) => boolean) =>
			bounded(
				new Promise<RpcSessionPresence>((resolve) => {
					const check = (): void => {
						const view = presence.view(sessionId);
						if (!predicate(view)) return;
						unsubscribe();
						resolve(view);
					};
					const unsubscribe = presence.subscribe(check);
					check();
				}),
				`a presence view of ${sessionId}`,
			),
		async [Symbol.asyncDispose]() {
			tools.releaseBarrier();
			await core.router.dispose();
			await writer.flush();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
