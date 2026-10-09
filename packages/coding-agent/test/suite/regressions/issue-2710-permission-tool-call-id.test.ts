/**
 * #2710: a permission request must say which tool call it approves.
 *
 * One assistant message carries three calls of the same tool. The engine prepares every call of a
 * message (running its `tool_call` hooks, where the permission prompt is raised) before any of
 * them ends, so a client that guesses the call from `tool_execution_start` events cannot tell
 * which one a prompt belongs to. Each `extension_ui_request` must carry its own `toolCallId`.
 *
 * Runs the real multi-session host core over the real `createCliRuntimeFactory`, so the builtin
 * permission extension loads as in a host-opened session; only the model is faked.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function threeReadsInOneMessage(answer: "Allow once" | "Deny") {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-2710-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	for (const name of ["a", "b", "c"]) await writeFile(join(cwd, `${name}.txt`), `${name}\n`);
	const faux = fauxProvider({ api: "fauxperm2710", provider: "fauxperm2710" });
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage(
			["a", "b", "c"].map((name) =>
				fauxToolCall("read", { path: join(cwd, `${name}.txt`) }, { id: `call-${name}` }),
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
		),
		closeGraceMs: 1_000,
	});
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	const writer = new SessionEventWriter(observe);
	writer.registerConnection("client", { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	disposers.push(async () => {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	let serial = 0;
	const send = async (command: Record<string, unknown>): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const direct = await writer.withConnection("client", () =>
			router.handle(JSON.parse(JSON.stringify({ ...command, id })) as RpcCommand),
		);
		await writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};

	const opened = await send({ type: "open_session", cwd, permissionPreset: "ask" });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
	if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	const isPrompt = (record: WireRecord): boolean =>
		record.sessionId === sessionId &&
		record.type === "extension_ui_request" &&
		record.method === "select" &&
		String(record.title ?? "").startsWith("Permission required:");
	listeners.add((record) => {
		if (!isPrompt(record)) return;
		void writer.withConnection("client", () =>
			router.handle(
				JSON.parse(
					JSON.stringify({ type: "extension_ui_response", id: String(record.id), sessionId, value: answer }),
				) as RpcCommand,
			),
		);
	});
	const idle = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("deadline waiting for agent_idle")), 30_000);
		listeners.add((record) => {
			if (record.type !== "agent_idle" || record.sessionId !== sessionId) return;
			clearTimeout(timer);
			resolve();
		});
	});
	const prompted = await send({ type: "prompt", sessionId, message: "read the three files" });
	if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
	await idle;
	await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
	return {
		cwd,
		prompts: records.filter(isPrompt),
		results: records.filter((record) => record.sessionId === sessionId && record.type === "tool_execution_end"),
	};
}

describe("a permission request names the tool call it approves (#2710)", () => {
	it("three calls of one tool in one message: each prompt carries its own call id", async () => {
		const { cwd, prompts } = await threeReadsInOneMessage("Deny");

		expect(
			prompts.map((prompt) => ({
				toolCallId: prompt.toolCallId,
				path: /Path: (.+)/.exec(String(prompt.title))?.[1],
				parent: prompt.parentToolCallId,
			})),
		).toEqual(
			["a", "b", "c"].map((name) => ({
				toolCallId: `call-${name}`,
				path: join(cwd, `${name}.txt`),
				parent: undefined,
			})),
		);
	});

	it("answering by call id approves exactly that call: each allowed read returns its own file", async () => {
		const { prompts, results } = await threeReadsInOneMessage("Allow once");

		expect(prompts.map((prompt) => prompt.toolCallId)).toEqual(["call-a", "call-b", "call-c"]);
		const resultText = (callId: string): string =>
			JSON.stringify(results.find((record) => record.toolCallId === callId)?.result ?? {});
		expect(resultText("call-a")).toContain("a\\n");
		expect(resultText("call-b")).toContain("b\\n");
		expect(resultText("call-c")).toContain("c\\n");
	});
});
