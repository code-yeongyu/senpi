import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import { makeSink, type RpcRecord } from "../rpc-connection-harness.ts";

// senpi#3864: kill the real engine, not a reducer mock, at each durable custody boundary.
const children = new Set<ChildProcessWithoutNullStreams>();
const directories: string[] = [];
async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
		child.kill("SIGKILL");
		await exited;
	}
	children.delete(child);
}
afterEach(async () => {
	for (const child of children) await kill(child);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(cwd: string, phase: string, sessionPath?: string) {
	const output = makeSink();
	let stderr = "";
	const child = spawn(
		"bun",
		[
			"--tsconfig-override",
			fileURLToPath(new URL("../../../../../tsconfig.json", import.meta.url)),
			fileURLToPath(new URL("../lifecycle-process-fixture.ts", import.meta.url)),
			cwd,
			phase,
			...(sessionPath ? [sessionPath] : []),
		],
		{
			env: { HOME: cwd, PATH: process.env.PATH, TMPDIR: cwd, PI_OFFLINE: "1", PI_SKIP_RUNTIME_NOTICE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.add(child);
	const exited = once(child, "exit").then(
		([code, signal]) => ({ code, signal, error: undefined }),
		(error: unknown) => ({ code: undefined, signal: undefined, error }),
	);
	child.stdout.on("data", (chunk: Buffer) => output.sink.writeRaw(chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return {
		child,
		records: output.messages,
		async stage(stage: string): Promise<RpcRecord> {
			try {
				return await Promise.race([
					output.waitFor((record) => record.stage === stage, 20_000),
					exited.then((result) => {
						throw new Error(`Engine exited before ${stage}: ${JSON.stringify(result)}; ${stderr}`);
					}),
				]);
			} catch (error) {
				throw new Error(`Missing ${stage}; engine stderr: ${stderr}`, { cause: error });
			}
		},
	};
}

it("redelivers a queued wake exactly once after restoration", async () => {
	const cwd = makeTempDir(join(tmpdir(), "3864-queued-"));
	directories.push(cwd);
	const original = run(cwd, "queued");
	const queued = await original.stage("checkpoint");
	expect(queued.sessionPath).toEqual(expect.any(String));
	await kill(original.child);
	const reopened = run(cwd, "reopen", String(queued.sessionPath));
	expect(await reopened.stage("restoring")).toMatchObject({ lifecycle: { restoring: true } });
	const restored = await reopened.stage("restored");
	expect(restored).toMatchObject({ lifecycle: { restoring: false, state: "done", epoch: 1 } });
	const entries = restored.entries as Array<{ type: string; details?: { ticketId?: string } }>;
	expect(entries.filter((entry) => entry.type === "custom_message" && entry.details?.ticketId)).toHaveLength(1);
	expect(
		reopened
			.records()
			.filter(
				(record) => record.stage === "lifecycle_event" && (record.lifecycle as { state?: string }).state === "done",
			),
	).toHaveLength(1);
});

for (const phase of ["before-tool", "after-result", "after-effect"] as const) {
	for (const unattended of [false, true]) {
		it(`does not replay a consumed wake ${phase}, ${unattended ? "unattended" : "attended"}`, async () => {
			const cwd = makeTempDir(join(tmpdir(), "3864-consumed-"));
			directories.push(cwd);
			const original = run(cwd, phase);
			const consumed = await original.stage("checkpoint");
			await kill(original.child);
			const reopened = run(cwd, unattended ? "reopen-unattended" : "reopen", String(consumed.sessionPath));
			expect(await reopened.stage("restoring")).toMatchObject({ lifecycle: { restoring: true } });
			const restored = await reopened.stage("restored");
			expect(restored).toMatchObject({
				lifecycle: {
					state: unattended ? "held" : "waiting_human",
					restoring: false,
					waitingOn: { human: [expect.objectContaining({ kind: "interrupted_run" })] },
				},
			});
			const entries = restored.entries as Array<{
				type: string;
				details?: { ticketId?: string };
				message?: { role: string; content: unknown };
			}>;
			expect(entries.filter((entry) => entry.type === "custom_message" && entry.details?.ticketId)).toHaveLength(1);
			if (phase === "after-effect")
				expect(entries).toContainEqual(
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({
							role: "toolResult",
							isError: true,
							content: [expect.objectContaining({ text: expect.stringContaining("INTERRUPTED") })],
						}),
					}),
				);
			const effects = join(cwd, "effects");
			expect(existsSync(effects) ? readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0).toBe(
				phase === "before-tool" ? 0 : 1,
			);
		});
	}
}

it("keeps the completion identity after a real kill without sealing it again", async () => {
	const cwd = makeTempDir(join(tmpdir(), "3864-sealed-"));
	directories.push(cwd);
	const original = run(cwd, "done");
	const sealed = await original.stage("sealed");
	await kill(original.child);
	const reopened = run(cwd, "reopen", String(sealed.sessionPath));
	const restored = await reopened.stage("restored");
	const previous = sealed.lifecycle as { completionId: string; epoch: number; completion: object };
	expect(restored.lifecycle).toMatchObject({
		state: "done",
		completionId: previous.completionId,
		epoch: previous.epoch,
		completion: previous.completion,
	});
	expect(
		reopened
			.records()
			.filter(
				(record) => record.stage === "lifecycle_event" && (record.lifecycle as { state?: string }).state === "done",
			),
	).toHaveLength(0);
});
