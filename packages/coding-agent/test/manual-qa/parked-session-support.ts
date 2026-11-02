import assert from "node:assert/strict";
import { type ChildProcess, execFile } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { MOCK_MODEL, requestText } from "../helpers/rpc-fake-model.ts";

export interface Snapshot {
	pid: number;
	closed: number;
	loops: Array<{ id: number; polls: number; active: boolean; stack: string }>;
	events: Array<{ type: string; sessionId: string }>;
}
export function observe(socketPath: string, query = ""): Promise<Snapshot> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, path: `/${query}`, agent: false }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("error", reject);
			res.on("end", () => {
				if (res.statusCode !== 200) return reject(new Error(`Observer ${res.statusCode}: ${body}`));
				try {
					resolve(JSON.parse(body) as Snapshot);
				} catch (error) {
					reject(error);
				}
			});
		});
		req.setTimeout(35_000, () => req.destroy(new Error("observer request timeout")));
		req.once("error", reject);
		req.end();
	});
}
export function nextPolls(snapshot: Snapshot): string {
	return `?wait=polling&${snapshot.loops.map((loop) => `loop${loop.id}=${loop.polls}`).join("&")}`;
}

/** Scripted local Anthropic SSE; one real monitor call, then a text-only end_turn. */
export async function fakeModel(paths: string[]) {
	const calls: Array<{ path: string; tool: boolean }> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("error", (error) => res.destroy(error));
		req.on("end", () => {
			try {
				assert(req.url?.includes("/messages"), "unexpected fake model route");
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					messages?: Array<{ content?: Array<{ type: string; tool_use_id?: string }> }>;
				};
				const index = Number(/parked-qa-watch-(\d+)/.exec(requestText(body))?.[1]);
				const path = paths[index];
				assert(path, "missing scripted monitor prompt marker");
				const id = `toolu_parked_${index}`;
				const done = calls.some((call) => call.path === path && call.tool);
				calls.push({ path, tool: !done });
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const send = (type: string, data: Record<string, unknown>) =>
					res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
				send("message_start", {
					message: {
						id: `msg_parked_${calls.length}`,
						type: "message",
						role: "assistant",
						model: MOCK_MODEL,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				});
				send("content_block_start", {
					index: 0,
					content_block: done ? { type: "text", text: "" } : { type: "tool_use", id, name: "monitor", input: {} },
				});
				send("content_block_delta", {
					index: 0,
					delta: done
						? { type: "text_delta", text: "Monitor ready." }
						: {
								type: "input_json_delta",
								partial_json: JSON.stringify({
									description: `QA watch ${index}`,
									path,
									event: "modify",
									persistent: true,
								}),
							},
				});
				send("content_block_stop", { index: 0 });
				send("message_delta", {
					delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null },
					usage: { output_tokens: 20 },
				});
				send("message_stop", {});
				res.end();
			} catch (error) {
				res.writeHead(500);
				res.end(String(error));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		calls,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

/** Subscribe before prompting; manifest persistence is fire-and-forget in the real tool. */
export function manifestWritten(path: string, watchedPath: string, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: unknown, value?: unknown) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			watcher.close();
			signal.removeEventListener("abort", abort);
			error ? reject(error) : resolve(value);
		};
		const inspect = async () => {
			try {
				const value = JSON.parse(await readFile(path, "utf8")) as {
					monitors?: Array<{ path?: string; event?: string; persistent?: boolean; runtimeKind?: string }>;
				};
				if (
					value.monitors?.some(
						(entry) =>
							entry.path === watchedPath &&
							entry.event === "modify" &&
							entry.persistent === true &&
							entry.runtimeKind === "file",
					)
				)
					finish(undefined, value);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(error);
			}
		};
		const watcher = watch(dirname(path), (_event, name) => {
			if (name === basename(path)) void inspect();
		});
		const timer = setTimeout(() => finish(new Error(`manifest timeout: ${path}`)), 30_000);
		const abort = () => finish(signal.reason);
		watcher.once("error", finish);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else void inspect();
	});
}

const exec = promisify(execFile);
export async function processProof(pid: number) {
	const { stdout: proof } = await exec("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,etime=,time=,command="]);
	const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "time="]);
	const { stdout: tree } = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="]);
	const rows = tree
		.trim()
		.split("\n")
		.map((line) => ({ line, fields: line.trim().split(/\s+/, 3) }));
	const family = new Set([pid]);
	for (let size = -1; size !== family.size; ) {
		size = family.size;
		for (const row of rows) if (family.has(Number(row.fields[1]))) family.add(Number(row.fields[0]));
	}
	const time = stdout.trim();
	const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
	const seconds = clock.split(":").reduce((total, field) => total * 60 + Number(field), 0) + Number(days) * 86400;
	assert(Number.isFinite(seconds), `unrecognized ps CPU time: ${time}`);
	return {
		seconds,
		proof: proof.trim(),
		processTree: rows.filter((row) => family.has(Number(row.fields[0]))).map((row) => row.line),
	};
}

export async function stopHost(host: ChildProcess): Promise<void> {
	if (host.pid === undefined || host.exitCode !== null || host.signalCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		const kill = setTimeout(() => host.kill("SIGKILL"), 5_000);
		const deadline = setTimeout(() => {
			cleanup();
			reject(new Error(`host ${host.pid} did not exit`));
		}, 10_000);
		const cleanup = () => {
			clearTimeout(kill);
			clearTimeout(deadline);
			host.off("exit", exited);
		};
		const exited = () => {
			cleanup();
			resolve();
		};
		host.once("exit", exited);
		host.kill("SIGTERM");
	});
}
