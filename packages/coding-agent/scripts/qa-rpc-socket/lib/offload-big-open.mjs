/**
 * `--big-open <MB,...>`: synthetic session files of the given sizes, opened through `open_session
 * { sessionPath }` to measure parse cost and the loop's responsiveness meanwhile. `--shape small`
 * writes many 2 KiB entries, `big` fewer 1 MiB entries. Written by streaming, never held in memory.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { connectRpc } from "./rpc-client.mjs";

const ENTRY_BYTES = { small: 2 * 1024, big: 1024 * 1024 };

export function writeBigSession(path, megabytes, shape, cwd) {
	const fd = openSync(path, "w");
	const target = megabytes * 1024 * 1024;
	const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date(0).toISOString(), cwd };
	let written = writeSync(fd, `${JSON.stringify(header)}\n`);
	const text = "p".repeat(ENTRY_BYTES[shape] ?? ENTRY_BYTES.small);
	let parentId = null;
	for (let index = 0; written < target; index++) {
		const id = `big${index.toString(36)}`;
		const role = index % 2 === 0 ? "user" : "assistant";
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: index }
				: { role, content: [{ type: "text", text }], api: "openai-completions", provider: "qa", model: "qa-mock-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: index };
		written += writeSync(fd, `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date(index).toISOString(), message })}\n`);
		parentId = id;
	}
	closeSync(fd);
	return statSync(path).size;
}

export async function runBigOpens({ socket, sizes, shape, dir, cwd }) {
	const results = [];
	for (const megabytes of sizes) {
		const file = join(dir, `big-${megabytes}mb-${shape}.jsonl`);
		const bytes = writeBigSession(file, megabytes, shape, cwd);
		const rpc = await connectRpc(socket, { label: `big${megabytes}` });
		const started = performance.now();
		const opened = await rpc.request({ type: "open_session", sessionPath: file, cwd }, 600_000);
		const openMs = Math.round(performance.now() - started);
		if (opened.success === true) await rpc.request({ type: "close_session", sessionId: opened.data.sessionId }, 120_000);
		rpc.close();
		results.push({ file: `big-${megabytes}mb-${shape}.jsonl`, bytes, openMs, ok: opened.success === true, ...(opened.success ? {} : { error: String(opened.error).slice(0, 300) }) });
	}
	return results;
}
