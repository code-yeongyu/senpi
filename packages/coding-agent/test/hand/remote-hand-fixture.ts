// Shared fixture for the S27a remote-executor tests: a session's remote ToolHost and a hand's executor joined by the
// reference transport over an in-process carrier (split-local: one machine, no relay), plus a faux model turn.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	createInProcessNetwork,
	createReliableTransport,
	createRemoteExecutor,
	createRemoteToolHost,
	localEndpoint,
	type OpenHandScope,
	type RemoteExecutor,
	type ToolHost,
	type Transport,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { parseArgs } from "../../src/cli/args.ts";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import type { CliRuntimeConfiguration } from "../../src/main.ts";
import { createLooplessHandScopes } from "../../src/modes/rpc/remote-executor-scope.ts";

const cleanups: Array<() => Promise<void> | void> = [];
const faults: unknown[] = [];

export async function cleanupHands(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	const reported = faults.splice(0);
	if (reported.length > 0) throw new Error(`hand faults: ${reported.map(String).join("; ")}`);
}

function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

export function openLink(): { readonly brain: TransportSide; readonly hand: TransportSide } {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `hand-${crypto.randomUUID()}`, "/tmp");
	const brain = side();
	const hand = side();
	const stop = network.listen(endpoint, hand);
	const link = network.dial(endpoint, brain);
	link.connect();
	cleanups.push(() => {
		link.drop();
		stop();
	});
	return { brain, hand };
}

export interface HandDirs {
	readonly scratch: string;
	readonly cwd: string;
	readonly agentDir: string;
}

export async function handDirs(prefix: string): Promise<HandDirs> {
	const scratch = await mkdtemp(join(tmpdir(), `senpi-s27a-${prefix}-`));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd, { recursive: true });
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	return { scratch, cwd, agentDir };
}

export function handConfiguration(dirs: HandDirs, extraArgs: readonly string[] = []): CliRuntimeConfiguration {
	return {
		parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates", ...extraArgs]),
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		appMode: "rpc",
	};
}

export function startHand(
	link: { readonly hand: Transport },
	dirs: HandDirs,
	extensionFactories: InlineExtension[],
	extraArgs: readonly string[] = [],
): RemoteExecutor {
	return startHandOn(link, createLooplessHandScopes(handConfiguration(dirs, extraArgs), { extensionFactories }));
}

export function startHandOn(link: { readonly hand: Transport }, openScope: OpenHandScope): RemoteExecutor {
	const executor = createRemoteExecutor({
		authority: { kind: "self" },
		fileChannel: true,
		transport: link.hand,
		openScope,
		onFault: (error) => faults.push(error),
	});
	cleanups.push(() => executor.close());
	return executor;
}

const model: Model<"openai-completions"> = {
	id: "s27a-faux",
	name: "s27a-faux",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function response(content: AssistantMessage["content"]) {
	const toolUse = content.some((item) => item.type === "toolCall");
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		content,
		stopReason: toolUse ? "toolUse" : "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
	return stream;
}

export function toolCall(id: string, name: string, args: ToolCall["arguments"]): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

/** Runs one session turn whose model issues `calls` once, through `toolHost` (fused when it is undefined). */
export async function runTurn(options: {
	readonly calls: readonly ToolCall[];
	readonly toolHost?: ToolHost;
	readonly root: string;
	readonly tools?: AgentTool[];
	readonly toolExecution?: "sequential" | "parallel";
}): Promise<{ readonly events: AgentEvent[]; readonly agent: Agent }> {
	let turns = 0;
	const agent = new Agent({
		initialState: { model, tools: options.tools ?? [] },
		streamFn: () => response(turns++ === 0 ? [...options.calls] : [{ type: "text", text: "done" }]),
		...(options.toolHost ? { toolHost: options.toolHost } : {}),
		...(options.toolExecution ? { toolExecution: options.toolExecution } : {}),
		executionScope: { id: `scope-${crypto.randomUUID()}`, root: options.root },
	});
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	await agent.prompt("go");
	return { events, agent };
}

export function remoteHost(link: { readonly brain: TransportSide }, sessionRef?: string) {
	return createRemoteToolHost({
		transport: link.brain,
		placement: "split-local",
		...(sessionRef === undefined ? {} : { sessionRef }),
	});
}

export function toolResultTexts(agent: Agent): string[] {
	return agent.state.messages.flatMap((message) =>
		message.role === "toolResult"
			? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
			: [],
	);
}
