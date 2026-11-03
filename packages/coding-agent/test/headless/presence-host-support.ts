/**
 * A headless host core (`headlessHostOptions` + `createHostCore`, real CLI runtimes on a faux provider) with a presence
 * binding over a memory DurableStore. Each prompt carries a plan `plan:<label>:<tool>,<tool>`: the faux model calls the tools in
 * order, then answers `done`. `barrier` holds its call until `releaseBarrier()`; on a hand session it runs on that
 * session's hand. A session opened in `handCwd(name)` runs every tool call on the fake hand `name` (an explicit
 * ToolHost, as a split session's remote host is); one opened in `fusedCwd` runs them in process.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ToolHost } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
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
import { EVENT_SAFETY_MS } from "../suite/event-safety-bound.ts";

export const OWNER = "owner-1";
type Wire = Record<string, unknown>;

const PLAN = /plan:(\w+):([\w,]*)/;
const planOf = (text: string): { readonly label: string; readonly tools: readonly string[] } => {
	const [, label = "", tools = ""] = PLAN.exec(text) ?? [];
	return { label, tools: tools.split(",").filter((tool) => tool !== "") };
};

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
			: "";

const toolResult = (text: string): AgentToolResult<Record<string, never>> => ({
	content: [{ type: "text", text }],
	details: {},
});

const bounded = <T>(promise: Promise<T>, what: string): Promise<T> =>
	Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`deadline waiting for ${what}`)), EVENT_SAFETY_MS).unref();
		}),
	]);

export async function startPresenceRig(options: { readonly presence?: boolean } = {}) {
	const scratch = await mkdtemp(join(tmpdir(), "headless-presence-"));
	const agentDir = join(scratch, "agent");
	const fusedCwd = join(scratch, "fused");
	const handCwds = new Map(["hand-1", "hand-2"].map((hand) => [hand, join(scratch, hand)]));
	for (const dir of [agentDir, fusedCwd, ...handCwds.values()]) await mkdir(dir);

	/** Provider requests in order: the plan label and how many tool results its context already held. */
	const requests: { label: string; step: number }[] = [];
	const handRuns: string[] = [];
	const ends = new Map<string, number>();
	const endWaiters = new Set<() => void>();
	let barrierStarted = Promise.withResolvers<void>();
	let barrierRelease = Promise.withResolvers<void>();
	const runTool = async (name: string, where: string): Promise<string> => {
		if (name === "barrier") {
			barrierStarted.resolve();
			await barrierRelease.promise;
		} else handRuns.push(where);
		return name;
	};

	const script: FauxResponseFactory = (context) => {
		const texts = context.messages.filter((message) => message.role === "user").map(({ content }) => textOf(content));
		const plan = planOf(texts.find((text) => PLAN.test(text)) ?? "");
		const step = context.messages.filter((message) => message.role === "toolResult").length;
		requests.push({ label: plan.label, step });
		const next = plan.tools[step];
		return next === undefined
			? fauxAssistantMessage("done")
			: fauxAssistantMessage([fauxToolCall(next, {})], { stopReason: "toolUse" });
	};
	const faux = fauxProvider({ models: [{ id: "faux-presence" }] });
	faux.setResponses(Array.from({ length: 64 }, () => script));
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
						execute: async () => toolResult(await runTool("barrier", "local")),
					});
				},
			],
		},
	);
	const hands = new WeakMap<object, readonly string[]>();
	const handHost = (hand: string): ToolHost => ({
		execute: async (call, { emit }) => {
			const messages: ToolResultMessage[] = [];
			for (const raw of call.calls) {
				await emit({ type: "tool_execution_start", toolCallId: raw.id, toolName: raw.name, args: raw.arguments });
				const result = { ...toolResult(await runTool(raw.name, hand)), isError: false };
				await emit({ type: "tool_execution_end", toolCallId: raw.id, toolName: raw.name, result, isError: false });
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: raw.id,
					toolName: raw.name,
					content: result.content,
					details: {},
					isError: false,
					timestamp: Date.now(),
				};
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				messages.push(message);
			}
			return { messages, terminate: false };
		},
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (input) => {
		const runtime = await cliRuntime(input);
		const { session } = runtime;
		const hand = [...handCwds].find(([, dir]) => dir === input.cwd)?.[0];
		if (hand !== undefined) session.agent.toolHost = handHost(hand);
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
		requests: (label: string) => requests.filter((entry) => entry.label === label).map(({ step }) => step),
		handRuns,
		fusedCwd,
		handCwd: (hand: string) => handCwds.get(hand) ?? fusedCwd,
		get barrierStarted() {
			return bounded(barrierStarted.promise, "the barrier");
		},
		releaseBarrier: () => barrierRelease.resolve(),
		resetBarrier: () => {
			barrierStarted = Promise.withResolvers<void>();
			barrierRelease = Promise.withResolvers<void>();
		},
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
		prompt: (connection: string, sessionId: string, label: string, tools: readonly string[]) =>
			send(connection, {
				type: "prompt",
				id: `prompt-${randomUUID()}`,
				sessionId,
				message: `plan:${label}:${tools.join(",")}`,
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
			barrierRelease.resolve();
			await core.router.dispose();
			await writer.flush();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
