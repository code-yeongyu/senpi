/**
 * `release_session` on a session that was never written, whose header write fails (its directory made
 * read-only, so a real EACCES), against a REAL `--mode rpc` host process: the release answers
 * `release_failed` with the error, the host keeps running and answers the next command, and the failed
 * header write never surfaces as an unhandled rejection.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import {
	type EndpointScratch,
	endpointScratch,
	hostArgs,
	hostEnv,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { processAlive } from "./helpers/spawned-host-reaper.ts";

const lockedDirs: string[] = [];

afterEach(async () => {
	for (const dir of lockedDirs.splice(0)) chmodSync(dir, 0o755);
	await sweepEndpointScratches();
}, 180_000);

async function socketHost(qa: EndpointScratch): Promise<{ pid: number; stderr: () => string }> {
	const cli = join(import.meta.dirname, "..", "src", "cli.ts");
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--listen", `unix://${qa.legacy}`, ...hostArgs()], {
		cwd: qa.cwd,
		env: { ...process.env, ...hostEnv(qa), SENPI_CODING_AGENT_DIR: qa.agentDir },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await new Promise<void>((resolve, reject) => {
		const onData = (): void => {
			if (!stderr.includes(`listening on unix://${qa.legacy}`)) return;
			child.stderr.off("data", onData);
			resolve();
		};
		child.stderr.on("data", onData);
		child.once("exit", () => reject(new Error(`host exited before listening: ${stderr}`)));
	});
	if (child.pid === undefined) throw new Error("host has no pid");
	trackSupervisor(child.pid);
	return { pid: child.pid, stderr: () => stderr };
}

/** Every observation is collected before asserting, so a host that died still reports each one. */
function answerOf(peer: JsonlPeer, command: Record<string, unknown>): Promise<Record<string, unknown>> {
	return peer.request(command, 10_000).catch((error: unknown) => ({ type: "no-answer", error: String(error) }));
}

function detailCode(answer: Record<string, unknown>): string | undefined {
	const data = answer.errorData;
	if (typeof data !== "object" || data === null || !("detail" in data)) return undefined;
	return String(data.detail).split(":")[0];
}

const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!unprivileged)("release_session when a never-written session's header write fails", () => {
	it("answers release_failed, and the host keeps running with no unhandled rejection", async () => {
		// Given: a real host with a session opened on a path nothing has written, in a directory that refuses it.
		const qa = endpointScratch("rhw");
		const host = await socketHost(qa);
		const peer = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(peer);
		const sessionDir = join(qa.root, "never");
		mkdirSync(sessionDir);
		const sessionPath = join(sessionDir, "never.jsonl");
		const opened = await peer.request({ type: "open_session", id: "open", cwd: qa.cwd, sessionPath });
		const sessionId = openedSessionId(opened);
		expect(existsSync(sessionPath)).toBe(false);
		chmodSync(sessionDir, 0o555);
		lockedDirs.push(sessionDir);

		// When: the session is released, and the host is asked something afterwards.
		const released = await answerOf(peer, {
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "takeover",
			force: true,
		});
		const followUp = await answerOf(peer, { type: "list_sessions", id: "after" });

		// Then: the release failed naming the error, the host is alive and answered, and nothing went unhandled.
		expect({
			release: { success: released.success, error: released.error, detail: detailCode(released) },
			fileWritten: existsSync(sessionPath),
			hostAlive: processAlive(host.pid),
			followUp: { type: followUp.type, success: followUp.success },
			unhandled: host
				.stderr()
				.split("\n")
				.filter((line) => /unhandled|EACCES/i.test(line)),
		}).toEqual({
			release: { success: false, error: "release_failed", detail: "EACCES" },
			fileWritten: false,
			hostAlive: true,
			followUp: { type: "response", success: true },
			unhandled: [],
		});
	}, 120_000);
});
