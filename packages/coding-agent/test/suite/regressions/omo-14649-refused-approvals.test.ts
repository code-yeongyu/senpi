/**
 * oh-my-openagent#14649: a thread another agent created runs with no client that answers its prompts. Under `read-only`
 * its `write` call became a permission prompt nobody answered, so the call never got a result and the turn never ended.
 * An opener that sets `open_session.context.approvals = "refuse"` declares that nobody answers: the call the permission
 * system would ask about is refused at once with a reason the model reads, and the turn completes.
 *
 * Runs the real multi-session host core over the real `createCliRuntimeFactory`, so the builtin permission extension
 * loads as in a host-opened session; only the model is faked. The client never answers a dialog, as no client does in
 * such a session; without the label the turn waits on the prompt and the bounded wait for `agent_idle` fails.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

async function readOnlyWriteTurn(context: Record<string, string>, until: "agent_idle" | "permission_prompt") {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const marker = join(cwd, "marker.txt");
	const faux = fauxProvider({ api: "fauxperm14649", provider: "fauxperm14649" });
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: marker, content: "probe" }, { id: "call-write" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("PROBE-DENIED"),
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

	const opened = await send({ type: "open_session", cwd, permissionPreset: "read-only", context });
	const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
	if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	const prompted = Promise.withResolvers<"prompted">();
	const idle = Promise.withResolvers<"idle">();
	listeners.add((record) => {
		if (record.sessionId !== sessionId) return;
		if (record.type === "agent_idle") idle.resolve("idle");
		if (
			record.type === "extension_ui_request" &&
			record.method === "select" &&
			String(record.title ?? "").startsWith("Permission required:")
		)
			prompted.resolve("prompted");
	});
	const deadline = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 15_000).unref());
	const reply = await send({ type: "prompt", sessionId, message: "create the marker file" });
	if (reply?.success === false) throw new Error(`prompt failed: ${String(reply.error)}`);
	const outcome = await Promise.race([until === "agent_idle" ? idle.promise : prompted.promise, deadline]);
	if (outcome === "idle") await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
	const ended = records.find((record) => record.sessionId === sessionId && record.type === "tool_execution_end");
	return { outcome, ended, wrote: existsSync(marker) };
}

describe("a session whose opener declared nobody answers its prompts refuses instead of asking (omo#14649)", () => {
	it("read-only write with context approvals=refuse: refused with a readable reason, and the turn ends", async () => {
		const { outcome, ended, wrote } = await readOnlyWriteTurn({ approvals: "refuse" }, "agent_idle");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
		expect(JSON.stringify(ended?.result)).toContain("nobody answers this session's prompts");
	});

	it("the same call without the label still asks (the label is what changes it)", async () => {
		const { outcome, wrote } = await readOnlyWriteTurn({}, "permission_prompt");

		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});
});
