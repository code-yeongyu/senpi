/**
 * Todo 9 scenarios (senpi#3566): the session's terminal tools on its tool child, on a real host with the
 * mock model driving the tool calls.
 *
 * `9-stream` (`--runtime child`): a foreground `yes | head -c 20000000` runs on the child; its output streams back as
 * progressive tool updates, the call ends with exit 0 and a truncated result that names a temp file, and the process
 * tree captured mid-run shows the command under the session's tool child.
 *
 * `9-child-kill-background` (`--runtime child`): a background session (`sleep 100 & wait`) is killed with the tool
 * child itself (SIGKILL); the exited record arrives, every process group the dead child owned is gone within 3 s, and
 * the next `bash_output` reports the session lost (the session died with its child, not "unknown id").
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QaFailure } from "./qa-failure.mjs";

const STREAM_COMMAND = "yes | head -c 20000000";
const BACKGROUND_COMMAND = "sleep 100 & wait";

function psRows() {
	const out = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout;
	const rows = [];
	for (const line of out.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match !== null)
			rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
	}
	return rows;
}

/** Every live row in `root`'s subtree except `root` itself, walking the ppid map. */
function descendantsOf(root) {
	const rows = psRows();
	const children = new Map();
	for (const row of rows) {
		const list = children.get(row.ppid) ?? [];
		list.push(row);
		children.set(row.ppid, list);
	}
	const out = [];
	const queue = children.get(root) ?? [];
	while (queue.length > 0) {
		const row = queue.shift();
		out.push(row);
		queue.push(...(children.get(row.pid) ?? []));
	}
	return out;
}

function writePstree(evidenceDir, name, root) {
	const self = psRows().find((row) => row.pid === root);
	const lines = [self, ...descendantsOf(root)]
		.filter((row) => row !== undefined)
		.map((row) => `${row.pid} pgid=${row.pgid} ${row.command}`);
	writeFileSync(join(evidenceDir, name), `${lines.join("\n")}\n`);
}

/** The text of the newest tool message, where the background start's bash_id arrives. */
function lastToolText(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "tool") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
	}
	return "";
}

function bashIdOf(text) {
	return /"bash_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /bash_id: ([\w-]+)/.exec(text)?.[1];
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

export const terminalStreamScenario = Object.freeze({
	id: "9-stream",
	requires: [4, 9],
	model: (() => {
		let stepped = false;
		return () => {
			if (stepped) return { text: "done" };
			stepped = true;
			return { tool: "bash", args: { command: STREAM_COMMAND } };
		};
	})(),
	async run(ctx) {
		const state = { childPid: undefined, updates: 0, end: undefined, snapped: false };
		ctx.rpc.subscribe((record) => {
			if (record.type === "session_tool_child" && record.state === "live" && state.childPid === undefined)
				state.childPid = record.pid;
			if (record.type === "tool_execution_update" && record.toolName === "bash") {
				state.updates += 1;
				if (!state.snapped && state.childPid !== undefined) {
					state.snapped = true;
					writePstree(ctx.evidenceDir, "9-stream.pstree.txt", state.childPid);
				}
			}
			if (record.type === "tool_execution_end" && record.toolName === "bash" && state.end === undefined)
				state.end = record;
		});
		const sessionId = await ctx.openSession();
		const ended = ctx.awaitRecord((r) => r.type === "tool_execution_end" && r.toolName === "bash", {
			name: "bash tool_execution_end",
			deadlineMs: 180_000,
		});
		await ctx.prompt(sessionId, "run the stream");
		await ended;
		const result = state.end?.result ?? {};
		const text = textOfContent(result.content);
		const fullOutputPath = result.details?.fullOutputPath;
		ctx.log.write({
			type: "assert",
			childPid: state.childPid,
			updateRecords: state.updates,
			isError: result.isError === true,
			truncated: result.details?.truncated === true || text.includes("truncated"),
			fullOutputPath: fullOutputPath ?? null,
		});
		if (state.childPid === undefined || state.childPid === process.pid)
			throw new QaFailure("assertion_failed", `the stream ran without a distinct tool child (pid ${state.childPid})`);
		if (state.updates < 1) throw new QaFailure("assertion_failed", "no progressive tool update reached the client");
		if (result.isError === true) throw new QaFailure("assertion_failed", `the bash call failed: ${text.slice(0, 200)}`);
		if (!(result.details?.truncated === true || text.includes("truncated")))
			throw new QaFailure("assertion_failed", "a 20 MB stream ended without a truncated result");
		if (typeof fullOutputPath !== "string")
			throw new QaFailure("assertion_failed", "the truncated result does not name a temp file with the full output");
	},
});

export function terminalChildKillScenario() {
	const state = { childPid: undefined, killedAt: undefined, exitedAt: undefined, groups: [] };
	return Object.freeze({
		id: "9-child-kill-background",
		requires: [4, 9],
		// The kill rides the model's own respond step: when the server asks for its next move with the background
		// start's result in hand, the driver kills the tool child BEFORE answering with the bash_output call, so the
		// read is dispatched against a child that is already dead.
		model: (() => {
			let asked = false;
			return (body) => {
				if (!asked) {
					asked = true;
					return { tool: "bash", args: { command: BACKGROUND_COMMAND, run_in_background: true } };
				}
				if (state.killedAt === undefined) {
					const id = bashIdOf(lastToolText(body));
					if (id === undefined || state.childPid === undefined) return { text: "no bash_id or child pid to kill" };
					state.groups = [...new Set(descendantsOf(state.childPid).map((row) => row.pgid))];
					process.kill(state.childPid, "SIGKILL");
					state.killedAt = Date.now();
					return { tool: "bash_output", args: { bash_id: id } };
				}
				return { text: "done" };
			};
		})(),
		async run(ctx) {
			ctx.rpc.subscribe((record) => {
				if (record.type === "session_tool_child" && record.state === "live" && state.childPid === undefined)
					state.childPid = record.pid;
				if (record.type === "session_tool_child" && record.state === "exited" && state.exitedAt === undefined)
					state.exitedAt = Date.now();
			});
			const sessionId = await ctx.openSession();
			const outputEnd = ctx.awaitRecord(
				(r) => r.type === "tool_execution_end" && r.toolName === "bash_output",
				{ name: "bash_output after the kill", deadlineMs: 120_000 },
			);
			await ctx.prompt(sessionId, "start the background session, then read it back");
			if (state.childPid === undefined || state.killedAt === undefined)
				throw new QaFailure("assertion_failed", "the turn never reached the armed kill");
			const record = await outputEnd;
			if (state.exitedAt === undefined)
				throw new QaFailure("assertion_failed", "no session_tool_child exited record after the kill");
			const text = textOfContent(record.result?.content);
			const groupsGone = state.groups.map((pgid) => {
				try {
					process.kill(-pgid, 0);
					return { pgid, gone: false };
				} catch {
					return { pgid, gone: true };
				}
			});
			ctx.log.write({
				type: "assert",
				childPid: state.childPid,
				ownedGroups: state.groups,
				groupsGone,
				msFromKillToExit: state.exitedAt - state.killedAt,
				lostReported: /lost/.test(text),
				outputText: text.slice(0, 300),
			});
			if (state.groups.length === 0)
				throw new QaFailure("assertion_failed", "the background session left no owned process group to sweep");
			if (groupsGone.some((entry) => !entry.gone))
				throw new QaFailure(
					"assertion_failed",
					`a process group of the killed child survived: ${JSON.stringify(groupsGone)}`,
				);
			if (state.exitedAt - state.killedAt > 3000)
				throw new QaFailure("assertion_failed", `the exited record took ${state.exitedAt - state.killedAt} ms, over the 3 s window`);
			if (!/lost/.test(text))
				throw new QaFailure(
					"assertion_failed",
					`bash_output after the child's death did not report the session lost: ${text.slice(0, 200)}`,
				);
		},
	});
}
