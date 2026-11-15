/**
 * senpi#6752: the terminal ops run on ONE engine-owned terminal manager (the class `bash` uses), behind an adapter that
 * keeps the relay host's wire: byte-offset `lastSeq` / `totalBytes`, the newest-page cursorless wait (#1217), a
 * `last_seq` resume, `replay_gap` and `unknown_handle`, the kill result, and handles that outlive the client connection.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DelegatedHost, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { answered, outcome, runOp, SENDER } from "./rpc-machine-op-support.ts";

const RUNNING = { state: "running", stdinOpen: true, outputClosed: false };
const EXITED_0 = { state: "exited", exitCode: 0, stdinOpen: false, outputClosed: true };
const KILLED = { state: "killed", stdinOpen: false, outputClosed: true };
/** One result carries at most this much output; the relay host's RESULT_OUTPUT_MAX. */
const PAGE_BYTES = 32 * 1024;
/** Output kept per handle; the relay host's RETAINED_OUTPUT_BYTES. */
const RETAINED_BYTES = 1024 * 1024;

let host: DelegatedHost;
let peer: Peer;
let root: string;

beforeAll(async () => {
	host = await startHost();
	peer = await host.proven();
	root = join(host.scratch, "work");
	await mkdir(root);
});
afterAll(async () => {
	await host.dispose();
});

const applied = (response: unknown) => outcome({ state: "applied", response });
const dataOf = (answer: Record<string, unknown>) => (answer.data as { response: Record<string, unknown> }).response;

async function exec(command: string, asker: Peer = peer): Promise<Record<string, unknown>> {
	const answer = await runOp(asker, "exec_command", { command, yield_ms: 250 }, { root });
	expect(answer).toEqual(
		applied({
			handleId: expect.any(String),
			output: expect.any(String),
			state: expect.any(String),
			lifecycle: expect.any(Object),
			lastSeq: expect.any(Number),
			truncated: expect.any(Boolean),
			omittedBytes: expect.any(Number),
			totalBytes: expect.any(Number),
			startedAtMs: expect.any(Number),
			elapsedMs: expect.any(Number),
			pid: expect.any(Number),
			reason: expect.any(String),
		}),
	);
	return dataOf(answer);
}

describe("senpi#6752: machine_op terminals", () => {
	it("execs, writes stdin, waits for the newest page, resumes from last_seq and kills an ended handle", async () => {
		const started = await exec("head -n1");
		expect(started).toMatchObject({
			output: "",
			state: "running",
			lifecycle: RUNNING,
			lastSeq: 0,
			truncated: false,
			omittedBytes: 0,
			reason: "timeout",
		});
		const handle_id = started.handleId;
		expect(await runOp(peer, "write_stdin", { handle_id, data: "hello\n" }, { root })).toEqual(
			applied({
				handleId: handle_id,
				output: expect.any(String),
				state: expect.any(String),
				lifecycle: expect.any(Object),
				lastSeq: expect.any(Number),
				truncated: false,
				omittedBytes: 0,
				totalBytes: expect.any(Number),
				startedAtMs: started.startedAtMs,
				elapsedMs: expect.any(Number),
				stdinEffect: { acceptedBytes: 6, observed: expect.any(Boolean) },
				reason: expect.any(String),
			}),
		);
		const ended = {
			handleId: handle_id,
			state: "completed",
			lifecycle: EXITED_0,
			truncated: false,
			omittedBytes: 0,
			totalBytes: 14,
			exitCode: 0,
			startedAtMs: started.startedAtMs,
			elapsedMs: expect.any(Number),
			reason: "exited",
		};
		const wait = { handle_id, until: ["exited"], yield_ms: 10_000 };
		expect(await runOp(peer, "wait_for_command", wait, { root })).toEqual(
			applied({ ...ended, output: "hello\r\nhello\r\n", lastSeq: 14 }),
		);
		expect(await runOp(peer, "wait_for_command", { ...wait, last_seq: 7 }, { root })).toEqual(
			applied({ ...ended, output: "hello\r\n", lastSeq: 14 }),
		);
		expect(await runOp(peer, "kill_terminal", { handle_id }, { root })).toEqual(
			applied({ handleId: handle_id, state: "task-failed", reason: "killed", lifecycle: EXITED_0 }),
		);
	});

	it("answers the newest page without a cursor and replay_gap for a cursor older than the retained output", async () => {
		const total = 1_100_000;
		const started = await exec(`head -c ${total} /dev/zero | tr '\\000' a`);
		const handle_id = started.handleId;
		const from = total - PAGE_BYTES;
		expect(
			await runOp(peer, "wait_for_command", { handle_id, until: ["exited"], yield_ms: 10_000 }, { root }),
		).toEqual(
			applied({
				handleId: handle_id,
				output: "a".repeat(PAGE_BYTES),
				state: "completed",
				lifecycle: EXITED_0,
				lastSeq: total,
				truncated: true,
				omittedBytes: from,
				totalBytes: total,
				exitCode: 0,
				startedAtMs: started.startedAtMs,
				elapsedMs: expect.any(Number),
				reason: "exited",
			}),
		);
		const retainedFrom = total - RETAINED_BYTES;
		expect(await runOp(peer, "wait_for_command", { handle_id, last_seq: 0 }, { root })).toEqual(
			outcome({
				state: "failed",
				error: {
					code: "replay_gap",
					message: `last_seq 0 precedes retained output at ${retainedFrom} (${retainedFrom} bytes omitted)`,
				},
			}),
		);
		expect(await runOp(peer, "wait_for_command", { handle_id: "nope" }, { root })).toEqual(
			outcome({ state: "failed", error: { code: "unknown_handle", message: "no handle nope on this host" } }),
		);
	});

	it("keeps a handle and its owner across a client reconnect, reports its process, then kills it", async () => {
		const first = await host.proven();
		const started = await exec("cat", first);
		const handle_id = started.handleId;
		await host.drop(first);
		const second = await host.proven();
		expect(await second.send({ type: "machine_op_owner", handle_id })).toEqual(
			answered("machine_op_owner", { sender: SENDER }),
		);
		expect(await runOp(second, "wait_for_command", { handle_id, yield_ms: 250 }, { root })).toEqual(
			applied({
				handleId: handle_id,
				output: "",
				state: "running",
				lifecycle: expect.any(Object),
				lastSeq: 0,
				truncated: false,
				omittedBytes: 0,
				totalBytes: 0,
				startedAtMs: started.startedAtMs,
				elapsedMs: expect.any(Number),
				reason: expect.any(String),
			}),
		);
		expect(await runOp(second, "process.info", { handleId: handle_id }, { root })).toEqual(
			applied({
				pid: started.pid,
				startedAtMs: expect.any(Number),
				cpuTimeMs: expect.any(Number),
				rssBytes: expect.any(Number),
				command: expect.any(String),
			}),
		);
		expect(await second.send({ type: "machine_op_health" })).toMatchObject({ data: { terminals: 1 } });
		expect(await runOp(second, "kill_terminal", { handle_id }, { root })).toEqual(
			applied({ handleId: handle_id, state: "task-failed", reason: "killed", lifecycle: KILLED }),
		);
		expect(await runOp(second, "process.info", { handleId: handle_id }, { root })).toEqual(
			outcome({ state: "failed", error: { code: "process_not_found", message: `no handle ${handle_id}` } }),
		);
	});
});
