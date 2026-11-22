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
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
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

/**
 * `from`: the session is first opened with the label, closed, then opened again with `context`: by its own file
 * (`reopen`, a wake after its process died) or by a fork of it (`fork`, a new session id carrying the copied entries).
 */
async function readOnlyWriteTurn(
	context: Record<string, string>,
	until: "agent_idle" | "permission_prompt",
	from?: "reopen" | "fork",
) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const marker = join(cwd, "marker.txt");
	const faux = fauxProvider({ api: "fauxperm14649", provider: "fauxperm14649" });
	const model = faux.getModel();
	faux.setResponses([
		...(from ? [fauxAssistantMessage("first turn")] : []),
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

	let reopenFrom: string | undefined;
	if (from) {
		const first = await send({
			type: "open_session",
			cwd,
			permissionPreset: "read-only",
			context: { approvals: "refuse" },
		});
		const data = first?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
		if (!data?.sessionId || !data.state?.sessionFile) throw new Error(`first open failed: ${JSON.stringify(first)}`);
		const firstIdle = Promise.withResolvers<void>();
		listeners.add((record) => {
			if (record.type === "agent_idle" && record.sessionId === data.sessionId) firstIdle.resolve();
		});
		await send({ type: "prompt", sessionId: data.sessionId, message: "hello" });
		await firstIdle.promise;
		await send({ type: "close_session", sessionId: data.sessionId });
		reopenFrom = data.state.sessionFile;
		if (from === "fork") {
			const original = SessionManager.open(reopenFrom);
			const leafId = original.getLeafId();
			if (!leafId) throw new Error("first session has no entries to fork");
			reopenFrom = original.createBranchedSession(leafId);
		}
	}
	const opened = await send({
		type: "open_session",
		cwd,
		permissionPreset: "read-only",
		...(reopenFrom === undefined ? {} : { sessionPath: reopenFrom }),
		...(Object.keys(context).length === 0 ? {} : { context }),
	});
	const openedData = opened?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
	const sessionId = openedData?.sessionId;
	if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	// Read before the first prompt: the refusal must already be in the file, bound to the id its header names.
	const fileAtOpen = openedData?.state?.sessionFile;
	const linesAtOpen =
		fileAtOpen !== undefined && existsSync(fileAtOpen)
			? readFileSync(fileAtOpen, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map(
						(line) =>
							JSON.parse(line) as {
								type?: string;
								id?: string;
								customType?: string;
								data?: { sessionId?: string };
							},
					)
			: [];
	const headerId = linesAtOpen.find((entry) => entry.type === "session")?.id;
	const recordedAtOpen = linesAtOpen.some(
		(entry) => entry.customType === "permission-approvals-refused" && entry.data?.sessionId === headerId,
	);
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
	return { outcome, ended, wrote: existsSync(marker), recordedAtOpen };
}

describe("a session whose opener declared nobody answers its prompts refuses instead of asking (omo#14649)", () => {
	it("read-only write with context approvals=refuse: refused with a readable reason, and the turn ends", async () => {
		const { outcome, ended, wrote, recordedAtOpen } = await readOnlyWriteTurn({ approvals: "refuse" }, "agent_idle");

		expect({ outcome, isError: ended?.isError, wrote, recordedAtOpen }).toEqual({
			outcome: "idle",
			isError: true,
			wrote: false,
			recordedAtOpen: true,
		});
		expect(JSON.stringify(ended?.result)).toContain("nobody answers this session's prompts");
	});

	it("a labelled session reopened by its file without the label still refuses (a wake after its process died)", async () => {
		const { outcome, ended, wrote } = await readOnlyWriteTurn({}, "agent_idle", "reopen");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
		expect(JSON.stringify(ended?.result)).toContain("nobody answers this session's prompts");
	});

	it("a fork of a labelled session opened without the label asks (the record is bound to the session id)", async () => {
		const { outcome, wrote } = await readOnlyWriteTurn({}, "permission_prompt", "fork");

		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});

	it("the same call without the label still asks (the label is what changes it)", async () => {
		const { outcome, wrote } = await readOnlyWriteTurn({}, "permission_prompt");

		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});
});
