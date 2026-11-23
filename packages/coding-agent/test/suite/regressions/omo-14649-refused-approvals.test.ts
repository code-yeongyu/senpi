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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { recordOpenerRefusal } from "../../../src/core/opener-approvals.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
type FileEntry = { type?: string; id?: string; customType?: string; data?: { sessionId?: string } };

const REFUSAL = "permission-approvals-refused";
const LABEL = { approvals: "refuse" };
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function entries(file: string | undefined): FileEntry[] {
	if (file === undefined || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as FileEntry);
}

/** The refusal records a file holds, and the id its own header names. */
function refusalsIn(file: string | undefined): { headerId: string | undefined; recordedFor: string[] } {
	const all = entries(file);
	return {
		headerId: all.find((entry) => entry.type === "session")?.id,
		recordedFor: all.filter((entry) => entry.customType === REFUSAL).map((entry) => String(entry.data?.sessionId)),
	};
}

async function host(turns: ReturnType<typeof fauxAssistantMessage>[], extraArgs: readonly string[] = []) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const faux = fauxProvider({ api: "fauxperm14649", provider: "fauxperm14649" });
	const model = faux.getModel();
	faux.setResponses(turns);
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
		...extraArgs,
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
	const open = async (fields: Record<string, unknown>) => {
		const reply = await send({ type: "open_session", cwd, permissionPreset: "read-only", ...fields });
		const data = reply?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
		return { reply, sessionId: data?.sessionId, sessionFile: data?.state?.sessionFile };
	};
	/** One prompt, settled: the turn ends at `agent_idle`. */
	const turn = async (sessionId: string) => {
		const idle = Promise.withResolvers<void>();
		const listener = (record: WireRecord) => {
			if (record.type === "agent_idle" && record.sessionId === sessionId) idle.resolve();
		};
		listeners.add(listener);
		await send({ type: "prompt", sessionId, message: "hello" });
		await idle.promise;
		listeners.delete(listener);
	};
	return { cwd, records, listeners, registry, send, open, turn };
}

/**
 * The session the final `write` call runs in. `before` is its history: `reopen` (opened with the label, closed, reopened
 * by its file), `record-removed` (the same, with the record deleted from the file in between), `late-label` (opened without it, a turn, then opened once with it), `file-fork` (a labelled session forked
 * on disk), `rpc-fork` / `rpc-clone` (a labelled session replaced in place by the RPC command).
 */
async function readOnlyWriteTurn(
	context: Record<string, string>,
	until: "agent_idle" | "permission_prompt",
	before?: "reopen" | "record-removed" | "late-label" | "live-attach" | "file-fork" | "rpc-fork" | "rpc-clone",
	extraArgs: readonly string[] = [],
) {
	const marker = "marker.txt";
	const h = await host(
		[
			...(before ? [fauxAssistantMessage("first turn")] : []),
			fauxAssistantMessage(fauxToolCall("write", { path: marker, content: "probe" }, { id: "call-write" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("PROBE-DENIED"),
		],
		extraArgs,
	);
	let sessionId: string | undefined;
	let fileAtOpen: string | undefined;
	let fork: { parent: string | undefined; file: string | undefined } | undefined;
	let replacementContext: Record<string, string> | undefined;
	if (before === "rpc-fork" || before === "rpc-clone") {
		const first = await h.open({ context: LABEL });
		if (!first.sessionId || !first.sessionFile) throw new Error(`first open failed: ${JSON.stringify(first.reply)}`);
		await h.turn(first.sessionId);
		const user = entries(first.sessionFile).find((entry) => entry.type === "message");
		const replaced = await h.send(
			before === "rpc-fork"
				? { type: "fork", sessionId: first.sessionId, entryId: user?.id }
				: { type: "clone", sessionId: first.sessionId },
		);
		if (replaced?.success !== true) throw new Error(`${before} failed: ${JSON.stringify(replaced)}`);
		sessionId = first.sessionId;
		replacementContext = { ...h.registry.peek(sessionId)?.runtime?.launchProfile?.sessionContext };
	} else {
		let reopenFrom: string | undefined;
		if (before) {
			const first = await h.open(before === "late-label" || before === "live-attach" ? {} : { context: LABEL });
			if (!first.sessionId || !first.sessionFile)
				throw new Error(`first open failed: ${JSON.stringify(first.reply)}`);
			await h.turn(first.sessionId);
			if (before !== "live-attach") await h.send({ type: "close_session", sessionId: first.sessionId });
			reopenFrom = first.sessionFile;
			if (before === "record-removed") {
				const kept = readFileSync(reopenFrom, "utf8")
					.split("\n")
					.filter((line) => !line.includes(REFUSAL));
				writeFileSync(reopenFrom, kept.join("\n"));
			}
			if (before === "late-label") {
				const labelled = await h.open({ sessionPath: reopenFrom, context: LABEL });
				if (!labelled.sessionId) throw new Error(`labelled reopen failed: ${JSON.stringify(labelled.reply)}`);
				await h.send({ type: "close_session", sessionId: labelled.sessionId });
			}
			if (before === "file-fork") {
				const original = SessionManager.open(reopenFrom);
				const leafId = original.getLeafId();
				if (!leafId) throw new Error("first session has no entries to fork");
				reopenFrom = original.createBranchedSession(leafId);
				fork = { parent: refusalsIn(first.sessionFile).headerId, file: reopenFrom };
			}
		}
		const opened = await h.open({
			...(before === "live-attach" ? { context: LABEL } : {}),
			...(reopenFrom === undefined ? {} : { sessionPath: reopenFrom }),
			...(Object.keys(context).length === 0 ? {} : { context }),
		});
		if (!opened.sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened.reply)}`);
		sessionId = opened.sessionId;
		fileAtOpen = opened.sessionFile;
	}
	// Read before the final prompt: what the file holds when the open answered.
	const atOpen = refusalsIn(fileAtOpen);
	const prompted = Promise.withResolvers<"prompted">();
	const idle = Promise.withResolvers<"idle">();
	h.listeners.add((record) => {
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
	const reply = await h.send({ type: "prompt", sessionId, message: "create the marker file" });
	if (reply?.success === false) throw new Error(`prompt failed: ${String(reply.error)}`);
	const outcome = await Promise.race([until === "agent_idle" ? idle.promise : prompted.promise, deadline]);
	if (outcome === "idle") await h.registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
	const ended = h.records.find((record) => record.sessionId === sessionId && record.type === "tool_execution_end");
	return { outcome, ended, wrote: existsSync(join(h.cwd, marker)), atOpen, fork, replacementContext };
}

describe("a session whose opener declared nobody answers its prompts refuses instead of asking (omo#14649)", () => {
	it("read-only write with context approvals=refuse: refused with a readable reason, and the turn ends", async () => {
		const { outcome, ended, wrote, atOpen } = await readOnlyWriteTurn(LABEL, "agent_idle");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
		expect(JSON.stringify(ended?.result)).toContain("nobody answers this session's prompts");
		// On disk, bound to the file's own id, before any prompt.
		expect(atOpen.recordedFor).toEqual([atOpen.headerId]);
	});

	it("a labelled write is refused while a path-specific rule makes the decision resolve path identities first", async () => {
		const { outcome, ended, wrote } = await readOnlyWriteTurn(LABEL, "agent_idle", undefined, [
			"--permission",
			"edit:/nonexistent-14649/**=allow",
		]);

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
	});

	it("a labelled session reopened by its file without the label still refuses (a wake after its process died)", async () => {
		const { outcome, ended, wrote } = await readOnlyWriteTurn({}, "agent_idle", "reopen");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
		expect(JSON.stringify(ended?.result)).toContain("nobody answers this session's prompts");
	});

	it("a labelled session whose record was deleted from its file asks on the next unlabelled open, never allows", async () => {
		const { outcome, wrote } = await readOnlyWriteTurn({}, "permission_prompt", "record-removed");

		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});

	it("a session first labelled after it has messages keeps refusing when reopened without the label", async () => {
		const { outcome, ended, wrote } = await readOnlyWriteTurn({}, "agent_idle", "late-label");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
	});

	it("a fork of a labelled session opened without the label asks (the record is bound to the session id)", async () => {
		const { outcome, wrote, fork } = await readOnlyWriteTurn({}, "permission_prompt", "file-fork");

		// The fork did copy the parent's record, under the parent's id, and has an id of its own.
		const copied = refusalsIn(fork?.file);
		expect(copied.recordedFor).toEqual([fork?.parent]);
		expect(copied.headerId).not.toBe(fork?.parent);
		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});

	it("a labelled open that attaches to the running unlabelled session refuses, with the record on disk when it answers", async () => {
		const { outcome, ended, wrote, atOpen } = await readOnlyWriteTurn({}, "agent_idle", "live-attach");

		expect({ outcome, isError: ended?.isError, wrote }).toEqual({ outcome: "idle", isError: true, wrote: false });
		expect(atOpen.recordedFor).toEqual([atOpen.headerId]);
	});

	it.each(["rpc-fork", "rpc-clone"] as const)(
		"an RPC %s of a labelled session asks: the opener's label stays with the session it opened",
		async (before) => {
			const { outcome, wrote, replacementContext } = await readOnlyWriteTurn({}, "permission_prompt", before);

			expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
			// The runtime's profile, which a retained session's restart record follows, no longer carries the label either.
			expect(replacementContext?.approvals).toBeUndefined();
		},
	);

	it("the same call without the label still asks (the label is what changes it)", async () => {
		const { outcome, wrote } = await readOnlyWriteTurn({}, "permission_prompt");

		expect({ outcome, wrote }).toEqual({ outcome: "prompted", wrote: false });
	});
});

describe("a labelled open fails when its refusal cannot be made durable (omo#14649)", () => {
	// A read-only directory does not stop root, so the write failure cannot be produced there.
	it.skipIf(process.getuid?.() === 0)(
		"an unwritable session folder fails the labelled open, not the unlabelled one",
		async () => {
			const h = await host([]);
			const sessionDir = getDefaultSessionDir(h.cwd);
			mkdirSync(join(sessionDir, "session-holders"), { recursive: true });
			chmodSync(sessionDir, 0o500);
			disposers.push(async () => chmodSync(sessionDir, 0o700));

			const unlabelled = await h.open({});
			const labelled = await h.open({ context: LABEL });

			expect(unlabelled.reply?.success).toBe(true);
			expect(labelled.reply?.success).toBe(false);
		},
	);

	it("a labelled open of an already recorded session still syncs, and fails when the sync fails", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-resync-"));
		disposers.push(() => rm(scratch, { recursive: true, force: true }));
		const session = SessionManager.create(scratch, join(scratch, "sessions"));
		await recordOpenerRefusal(session);

		await expect(
			recordOpenerRefusal(session, {
				syncFile: () => Promise.reject(new Error("EIO: sync failed")),
				syncDirectory: () => Promise.resolve(),
			}),
		).rejects.toThrow("EIO: sync failed");
	});

	it("a labelled parked session is claimed only once its refusal is in the session file", async () => {
		const h = await host([]);
		expect(await h.send({ type: "park_session", cwd: h.cwd, context: LABEL })).toMatchObject({ success: true });
		const claimed = await h.send({ type: "claim_session", cwd: h.cwd, context: LABEL });
		const file = (claimed?.data as { state?: { sessionFile?: string } } | undefined)?.state?.sessionFile;

		const atClaim = refusalsIn(file);
		expect(atClaim.recordedFor).toEqual([atClaim.headerId]);
	});

	it("a sync that fails rejects the record instead of reporting it written", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-sync-"));
		disposers.push(() => rm(scratch, { recursive: true, force: true }));
		const session = SessionManager.create(scratch, join(scratch, "sessions"));

		await expect(
			recordOpenerRefusal(session, {
				syncFile: () => Promise.reject(new Error("EIO: sync failed")),
				syncDirectory: () => Promise.resolve(),
			}),
		).rejects.toThrow("EIO: sync failed");
	});
});
