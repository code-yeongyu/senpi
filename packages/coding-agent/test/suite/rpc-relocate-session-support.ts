/**
 * One real session (suite harness, faux provider, the builtin relocation extension) behind the real RPC
 * connection handler, and a scripted host on the other end of the wire that answers its `host_request`s.
 */
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

export type WireRecord = Record<string, unknown> & { readonly type?: string; readonly id?: string };
/** What the scripted host answers to one `host_request`; `undefined` leaves it unanswered. */
export type HostScript = (request: WireRecord) => Record<string, unknown> | undefined;

function runtimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

export interface RelocationRig {
	readonly harness: Harness;
	readonly handler: RpcConnectionHandler;
	readonly records: WireRecord[];
	readonly replies: () => WireRecord[];
	cleanup(): Promise<void>;
}

export async function relocationRig(options: {
	readonly capabilities?: readonly string[];
	readonly host?: HostScript;
}): Promise<RelocationRig> {
	const harness = await createHarness({ extensionFactories: [relocateSessionExtension], persistSession: true });
	const records: WireRecord[] = [];
	let handler: RpcConnectionHandler | undefined;
	let buffer = "";
	const receive = (record: WireRecord): void => {
		records.push(record);
		if (record.type !== "host_request" || options.host === undefined) return;
		const answer = options.host(record);
		if (answer !== undefined)
			queueMicrotask(
				() => void handler?.handleInputLine(JSON.stringify({ type: "host_response", id: record.id, ...answer })),
			);
	};
	handler = createRpcConnectionHandler(
		runtimeHost(harness.session),
		{
			writeRaw(chunk) {
				buffer += chunk;
				for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) receive(JSON.parse(line) as WireRecord);
				}
			},
			waitForBackpressure: async () => {},
		},
		{ sessionId: "rpc-1", capabilities: options.capabilities ? [...options.capabilities] : undefined },
	);
	await handler.ready;
	const bound = handler;
	return {
		harness,
		handler: bound,
		records,
		replies: () => records.filter((record) => record.type === "response" && record.command === "host_response"),
		async cleanup() {
			await bound.dispose();
			harness.cleanup();
		},
	};
}

export async function runToolTurn(
	rig: RelocationRig,
	name: string,
	args: Parameters<typeof fauxToolCall>[1],
	closing = "ok",
) {
	rig.harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage(closing),
	]);
	await rig.harness.session.prompt(`call ${name}`);
	await rig.harness.session.agent.waitForIdle();
	return getToolResult(rig.harness, name);
}

/** The session still takes a turn here and writes it to its own file: it was never handed away. */
export async function stillWritableHere(rig: RelocationRig): Promise<boolean> {
	rig.harness.setResponses([fauxAssistantMessage("still here")]);
	await rig.harness.session.prompt("keep going");
	await rig.harness.session.agent.waitForIdle();
	const file = rig.harness.session.sessionFile;
	if (file === undefined) return false;
	return (await readFile(file, "utf8")).includes("still here");
}

export const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
	result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
