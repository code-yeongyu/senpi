/**
 * Todo 7 scenarios (senpi#3566): the reverse bridge on a real host.
 *
 * `7-hostcall-large-args-and-reply`: a child-run `qa_hostcall` sends 17 MiB of arguments to `qa_sink` (built in the child
 * with `fill`, so the model never carries them) and asks the server-placed `qa_blob_server` for a 20 MiB reply. The
 * driver checks the sink digest, the reply size, and that no payload reference is left once both calls ended.
 *
 * `7-lock-drain` (`--inject SUSPEND_WRITE`): two sessions append to one file with `qa_mutate`. A holds the file's lock
 * with its write suspended and is aborted; B's call must not end while A's write is pending, and once A's write is
 * released B's result follows it in the file.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QaFailure } from "./qa-failure.mjs";

const SINK_BYTES = 17 * 1024 * 1024;
const BLOB_BYTES = 20 * 1024 * 1024;

function toolMessages(body) {
	return (body.messages ?? []).filter((message) => message.role === "tool").length;
}

function userText(body) {
	const user = (body.messages ?? []).find((message) => message.role === "user");
	const content = user?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

function outcomeOf(record) {
	const outcome = record.result?.details?.outcomes?.[0];
	if (outcome === undefined) throw new QaFailure("assertion_failed", `no hostcall outcome in ${JSON.stringify(record.result).slice(0, 200)}`);
	return outcome;
}

/** Payload files left under `<agentDir>/tool-children/<session>/refs`, every generation. */
function refsLeft(root) {
	let generations = [];
	try {
		generations = readdirSync(root);
	} catch {
		return [];
	}
	return generations.flatMap((generation) => {
		try {
			return readdirSync(join(root, generation, "refs")).map((name) => `${generation}/refs/${name}`);
		} catch {
			return [];
		}
	});
}

/** Resolves once no payload file is left under `root`, watching it (bounded). */
async function refsDrained(root, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const left = refsLeft(root);
		if (left.length === 0) return;
		if (Date.now() > deadline) throw new QaFailure("assertion_failed", `refs left: ${left.join(", ")}`);
		await new Promise((resolveChange) => {
			const watcher = watch(root, { recursive: true }, () => {
				clearTimeout(timer);
				watcher.close();
				resolveChange();
			});
			const timer = setTimeout(() => {
				watcher.close();
				resolveChange();
			}, Math.max(0, deadline - Date.now()));
		});
	}
}

export const hostcallLargeScenario = Object.freeze({
	id: "7-hostcall-large-args-and-reply",
	requires: [4, 7],
	needsExtension: true,
	model(body) {
		const steps = [
			{ tool: "qa_hostcall", args: { tool: "qa_sink", args: {}, count: 1, fill: { field: "payload", bytes: SINK_BYTES } } },
			{ tool: "qa_hostcall", args: { tool: "qa_blob_server", args: { bytes: BLOB_BYTES }, count: 1 } },
			{ text: "hostcall QA done" },
		];
		return steps[Math.min(toolMessages(body), steps.length - 1)];
	},
	async run(ctx) {
		const sessionId = await ctx.openSession();
		const ends = [];
		const ended = ctx.awaitRecord(
			(r) => {
				if (r.sessionId !== sessionId || r.type !== "tool_execution_end" || r.toolName !== "qa_hostcall") return false;
				ends.push(r);
				return ends.length === 2;
			},
			{ name: "two qa_hostcall tool_execution_end", deadlineMs: 180_000 },
		);
		await ctx.prompt(sessionId, "run the reverse-bridge QA");
		await ended;
		const [sinkRecord, blobRecord] = ends;
		const sink = outcomeOf(sinkRecord);
		const blob = outcomeOf(blobRecord);
		const expected = createHash("sha256").update("s".repeat(SINK_BYTES), "utf8").digest("hex");
		ctx.log.write({ type: "assert", call: "qa_sink", isError: sink.isError, digestMatches: sink.text === expected, sentBytes: SINK_BYTES });
		ctx.log.write({ type: "assert", call: "qa_blob_server", isError: blob.isError, bytes: blob.bytes, expected: BLOB_BYTES });
		if (sinkRecord.isError || sink.isError || sink.text !== expected)
			throw new QaFailure("assertion_failed", `qa_sink digest ${String(sink.text).slice(0, 80)}`);
		if (blobRecord.isError || blob.isError || blob.bytes !== BLOB_BYTES)
			throw new QaFailure("assertion_failed", `qa_blob_server reply ${blob.bytes} bytes`);
		const refsRoot = join(ctx.agentDir, "tool-children", await ctx.durableSessionIdOf(sessionId), "refs");
		await refsDrained(refsRoot, 10_000);
		ctx.log.write({ type: "assert", refsRoot, refsLeft: 0 });
	},
});

export const lockDrainScenario = Object.freeze({
	id: "7-lock-drain",
	requires: [4, 7],
	needsExtension: true,
	model(body) {
		if (toolMessages(body) > 0) return { text: "mutated" };
		// The prompt reaches the model wrapped in context; the request is the one JSON object in it.
		const request = userText(body).match(/\{"path":.*?"line":"[^"]*"\}/)?.[0];
		if (request === undefined) return { text: "no qa_mutate request in the prompt" };
		const { path, line } = JSON.parse(request);
		return { tool: "qa_mutate", args: { path, line } };
	},
	async run(ctx) {
		const work = mkdtempSync(join(tmpdir(), "qa-lock-drain-"));
		const file = join(work, "shared.txt");
		writeFileSync(file, "");
		try {
			const a = await ctx.openSession();
			const b = await ctx.openSession();
			const endOf = (sessionId) =>
				ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "tool_execution_end" && r.toolName === "qa_mutate", {
					name: `qa_mutate end ${sessionId}`,
					deadlineMs: 120_000,
				});
			const aEnd = endOf(a);
			void aEnd.catch(() => undefined);
			const bEnd = endOf(b);
			await ctx.prompt(a, JSON.stringify({ path: file, line: "A" }));
			await ctx.awaitControlFile((name) => name === "write-suspended", 60_000);
			ctx.log.write({ type: "step", step: "a_suspended_holding_lock" });
			await ctx.rpc.request({ type: "abort", sessionId: a });
			await ctx.prompt(b, JSON.stringify({ path: file, line: "B" }));
			let bEarly = false;
			await Promise.race([
				bEnd.then(() => {
					bEarly = true;
				}),
				new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
			]);
			ctx.log.write({ type: "assert", step: "b_waits_while_a_write_pending", bEnded: bEarly });
			if (bEarly) throw new QaFailure("assertion_failed", "B's mutation ended while A still held the lock");
			writeFileSync(join(ctx.controlDir, "release-write"), "");
			ctx.log.write({ type: "step", step: "a_write_released" });
			const bRecord = await bEnd;
			const content = readFileSync(file, "utf8");
			ctx.log.write({ type: "assert", step: "b_after_a", bIsError: bRecord.isError, content });
			if (bRecord.isError || content !== "A\nB\n")
				throw new QaFailure("assertion_failed", `file after both mutations: ${JSON.stringify(content)}`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	},
});
