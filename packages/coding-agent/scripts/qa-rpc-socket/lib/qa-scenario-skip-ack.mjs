/**
 * `4-skip-ack-wait-detected` (senpi#3566 todo 4): the failure scenario. With every ack held and the hook mutated to
 * invoke anyway (`SKIP_ACK_WAIT`), six sessions each launch one API. The server must catch every launch as a
 * violation (`launch_proof` with `ackTick === null`), kill that session's child, and clean up by lifetime: an owned
 * command's group is gone within 3 s; the detached command survives the child and the driver removes it. The detached
 * proof is held (`HOLD_LAUNCH_PROOF:detached`) until the driver saw the command actually start (its marker appeared),
 * so "detected" can never mean "detected before anything ran". Run with
 * `--inject HOLD_LAUNCH_ACK,SKIP_ACK_WAIT,HOLD_LAUNCH_PROOF:detached --expect-failure tool_child_barrier_violation`.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { kill } from "node:process";
import { launchLog } from "./qa-launch-tail.mjs";
import { QaFailure } from "./qa-failure.mjs";

const APIS = [
	{ api: "bun.spawn", lifetime: "owned" },
	{ api: "bun.spawnSync", lifetime: "owned" },
	{ api: "bun.shell", lifetime: "owned" },
	{ api: "cp.spawn", detached: true, lifetime: "detached" },
	{ api: "cp.spawn", detached: false, lifetime: "owned" },
	{ api: "cp.execFileSync", lifetime: "owned" },
];

function assert(condition, message) {
	if (!condition) throw new QaFailure("assertion_failed", message);
}

function groupGone(pgid) {
	try {
		kill(-pgid, 0);
		return false;
	} catch {
		return true;
	}
}

async function awaitGroupGone(pgid, windowMs = 3_000) {
	const deadline = Date.now() + windowMs;
	for (;;) {
		if (groupGone(pgid)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}

function promptIndex(body) {
	const user = (body.messages ?? []).find((message) => message.role === "user");
	const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
	return Number(/qa-api:(\d+)/.exec(text)?.[1] ?? 0);
}

export function skipAckWaitScenario() {
	// The mock model runs in the driver, which learns the control dir only when the scenario starts.
	let controlDir;
	return Object.freeze({
		id: "4-skip-ack-wait-detected",
		requires: [4],
		needsExtension: true,
		model(body) {
			const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool").length;
			if (toolMessages > 0) return { text: "launch reported" };
			const index = promptIndex(body);
			const { api, detached } = APIS[index];
			const marker = join(controlDir, `started-${index}`);
			return {
				tool: "qa_spawn",
				args: { api, argv: ["sh", "-c", `touch "${marker}"; exec env -i /bin/sleep 300`], ...(detached === undefined ? {} : { detached }) },
			};
		},
		async run(ctx) {
			controlDir = ctx.controlDir;
			const sessions = [];
			for (const [index, entry] of APIS.entries()) {
				const sessionId = await ctx.openSession();
				const exited = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "session_tool_child" && r.state === "exited", {
					name: `session_tool_child exited (${entry.api}#${index})`,
					deadlineMs: 120_000,
				});
				const spawned = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "session_tool_child" && r.state === "spawned", {
					name: `session_tool_child spawned (${entry.api}#${index})`,
					deadlineMs: 120_000,
				});
				await ctx.prompt(sessionId, `launch it now qa-api:${index}`);
				sessions.push({ index, entry, sessionId, exited, spawned });
			}
			const detected = [];
			const toolEnds = new Map();
			ctx.rpc.subscribe((r) => {
				if (r.type === "tool_execution_end" && r.toolName === "qa_spawn")
					toolEnds.set(r.sessionId, { isError: r.isError === true, result: JSON.stringify(r.result?.content ?? null).slice(0, 400) });
			});
			try {
			for (const session of sessions) {
				const { index, entry, sessionId } = session;
				const child = await session.spawned;
				const log = launchLog(ctx.agentDir, await ctx.durableSessionIdOf(sessionId));
				const launch = await log.waitFor((r) => r.type === "launch", { name: `launch ${entry.api}#${index}`, deadlineMs: 60_000 });
				if (entry.lifetime === "detached") {
					await ctx.awaitControlFile((name) => name === `started-${index}`, 60_000);
					ctx.log.write({ type: "fixture_started", launchId: launch.launchId, marker: `started-${index}` });
					await ctx.control.releaseProof(launch.launchId);
				}
				const proof = await log.waitFor((r) => r.type === "launch_proof" && r.launchId === launch.launchId, { name: `proof ${launch.launchId}` });
				assert(proof.ackTick === null, `${entry.api}#${index} proof carried ackTick ${proof.ackTick}`);
				const violation = await log.waitFor((r) => r.type === "violation" && r.launchId === launch.launchId, { name: `violation ${launch.launchId}` });
				await session.exited;
				let cleanup;
				if (entry.lifetime === "owned") {
					const pgid = launch.containment === "own-group" ? launch.pgid : child.pid;
					cleanup = { kind: "owned_group_gone", pgid, gone: await awaitGroupGone(pgid) };
					assert(cleanup.gone, `${entry.api}#${index} group ${pgid} still alive 3 s after the child exited`);
				} else {
					const pid = launch.pid;
					const survived = !groupGone(pid);
					assert(survived, `the detached command ${pid} did not survive the child`);
					kill(-pid, "SIGKILL");
					const gone = await awaitGroupGone(pid);
					cleanup = { kind: "fixture_cleanup", launchId: launch.launchId, pid, method: "SIGKILL", survivedChild: survived, gone };
					assert(gone, `detached command ${pid} survived SIGKILL`);
				}
				ctx.log.write({ type: "assert", api: entry.api, index, launchId: launch.launchId, ackTick: proof.ackTick, violation: violation.reason, cleanup });
				await ctx.control.releaseAck(launch.launchId);
				copyFileSync(log.path, join(ctx.evidenceDir, `launches-${index}.jsonl`));
				detected.push(launch.launchId);
			}
			} finally {
				// Every session's launch log and tool result is evidence, also when an earlier session failed the run.
				for (const session of sessions) {
					const durable = await ctx.durableSessionIdOf(session.sessionId).catch(() => undefined);
					const path = durable === undefined ? undefined : launchLog(ctx.agentDir, durable).path;
					const copied = path !== undefined && existsSync(path);
					if (copied) copyFileSync(path, join(ctx.evidenceDir, `launches-${session.index}.jsonl`));
					ctx.log.write({ type: "session_evidence", index: session.index, api: session.entry.api, copied, tool: toolEnds.get(session.sessionId) ?? null });
				}
			}
			ctx.log.write({ type: "detected_all", count: detected.length });
			throw new QaFailure("tool_child_barrier_violation", `${detected.length}/6 launches caught invoking before their ack`);
		},
	});
}
