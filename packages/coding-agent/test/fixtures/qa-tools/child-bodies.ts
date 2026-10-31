// The QA fixture tools' bodies as the tool child runs them (senpi#3566 todo 4): each export receives the `module` job's
// `{ params, toolCallId }` and the job's host (todo 7: the reverse bridge), and returns a tool result.
import { setTimeout as delay } from "node:timers/promises";
import { blobText, hostcallArgs, mutateFile, raiseSegv, runHostcalls, sinkDigest } from "../qa-tools-extension.ts";
import { type SpawnFixtureParams, spawnFixture } from "./spawn-fixture.ts";

interface ChildInput<P> {
	readonly params: P;
	readonly toolCallId: string;
}

/** What a body uses of its job's host (the module host of a `module` job). */
interface ChildHost {
	call(
		name: string,
		args: unknown,
	): Promise<{
		readonly result: { readonly content: readonly { type: string; text?: string }[] };
		readonly isError: boolean;
	}>;
	withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

const controlDir = (): string => process.env.SENPI_TOOL_CHILD_TEST_CONTROL_DIR ?? process.cwd();

function result(text: string, details: unknown) {
	return { content: [{ type: "text", text }], details };
}

export async function qa_sleep({ params }: ChildInput<{ ms: number }>) {
	await delay(params.ms);
	return result(`slept ${params.ms}ms`, { ms: params.ms, pid: process.pid });
}

export function qa_blob({ params }: ChildInput<{ bytes: number }>) {
	return result(blobText(params.bytes), { bytes: params.bytes, pid: process.pid });
}

export function qa_sink({ params }: ChildInput<{ payload: string }>) {
	const digest = sinkDigest(params.payload);
	return result(digest, { sha256: digest, bytes: Buffer.byteLength(params.payload, "utf8"), pid: process.pid });
}

export async function qa_spawn({ params, toolCallId }: ChildInput<SpawnFixtureParams>) {
	const launchId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
	const spawned = await spawnFixture(params, { controlDir: controlDir(), launchId });
	return result(JSON.stringify(spawned), { launchId, ...spawned, pid: process.pid });
}

export async function qa_hostcall(
	{ params }: ChildInput<{ tool: string; args: unknown; count: number; fill?: { field: string; bytes: number } }>,
	host: ChildHost,
) {
	const outcomes = await runHostcalls({ ...params, args: hostcallArgs(params) }, async (name, args) => {
		const outcome = await host.call(name, args);
		const text = outcome.result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
		return { isError: outcome.isError, text };
	});
	// A reply can be tens of MiB: report its size and digest, and only a short prefix of its text.
	const reported = outcomes.map(({ index, isError, text }) => ({
		index,
		isError,
		bytes: Buffer.byteLength(text, "utf8"),
		sha256: sinkDigest(text),
		text: text.slice(0, 200),
	}));
	return result(JSON.stringify(reported.map(({ index, isError, bytes }) => ({ index, isError, bytes }))), {
		outcomes: reported,
		pid: process.pid,
	});
}

export async function qa_mutate({ params }: ChildInput<{ path: string; line: string }>, host: ChildHost) {
	const suspend = process.env.SENPI_TOOL_CHILD_TEST_SUSPEND_WRITE !== undefined;
	// The session's lock for the file: held until this write is done, through a cancel (drain before release).
	await host.withFileLock(params.path, () => mutateFile(params, { suspend, controlDir: controlDir() }));
	return result(`appended to ${params.path}`, { suspended: suspend, pid: process.pid });
}

export function qa_segv() {
	raiseSegv({
		kill: (pid, signal) => process.kill(pid, signal),
		exit: (code) => process.exit(code),
		platform: process.platform,
	});
	return result("qa_segv returned without terminating", { pid: process.pid });
}
