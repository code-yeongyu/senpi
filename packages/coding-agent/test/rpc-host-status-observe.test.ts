/**
 * Looking at a host must not keep it alive: `senpi host status [--all]` reads are observing reads,
 * so a poller (a runtime panel, a doctor loop) leaves every endpoint's idle window running. The
 * supervisor-side classification is covered on a driven clock in `rpc-host-lifecycle.test.ts`; this
 * suite proves the whole path against a real supervised host and the real `status --all`, and that a
 * bare socket host's own empty-exit window applies the same rule to a connection that only observes.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlPeer } from "./helpers/rpc-generation-support.ts";
import {
	type EndpointScratch,
	endpointScratch,
	heldRealHost,
	hostArgs,
	hostEnv,
	realHost,
	statusAll,
	sweepEndpointScratches,
	tracked,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { processAlive, waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

const IDLE_EXIT_MS = 3_000;
const POLL_INTERVAL_MS = 1_000;

/** A socket host started bare (`--listen`, no supervisor), whose own empty-exit window is `emptyExitMs`. */
async function bareSocketHost(qa: EndpointScratch, socket: string, emptyExitMs: number): Promise<number> {
	const cli = join(import.meta.dirname, "..", "src", "cli.ts");
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--listen", `unix://${socket}`, ...hostArgs()], {
		cwd: qa.cwd,
		env: {
			...process.env,
			...hostEnv(qa),
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RPC_HOST_EMPTY_EXIT_MS: String(emptyExitMs),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		let stderr = "";
		const onData = (chunk: Buffer): void => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes(`listening on unix://${socket}`)) return;
			child.stderr.off("data", onData);
			child.stderr.resume();
			resolve();
		};
		child.stderr.on("data", onData);
		child.once("exit", () => reject(new Error(`bare host exited before listening: ${stderr}`)));
	});
	if (child.pid === undefined) throw new Error("bare host has no pid");
	return child.pid;
}

describe.skipIf(process.platform === "win32")("host status reads and idle exit", () => {
	it("lets a host idle out on schedule while status --all polls it every second", async () => {
		const qa = endpointScratch("poll");
		const supervisor = await realHost(qa, qa.shard, { idleExitMs: IDLE_EXIT_MS });
		const ensuredAt = Date.now();
		let exited: boolean | undefined;
		const exit = waitForPidGone(supervisor, 10 * IDLE_EXIT_MS).then((gone) => {
			exited = gone;
		});
		let reachablePolls = 0;
		while (exited === undefined) {
			const { endpoints } = await statusAll(qa);
			if (endpoints.some((endpoint) => endpoint.reachable)) reachablePolls++;
			await Promise.race([exit, delay(POLL_INTERVAL_MS)]);
		}

		expect(exited).toBe(true);
		expect(reachablePolls).toBeGreaterThanOrEqual(2);
		expect(Date.now() - ensuredAt).toBeLessThan(IDLE_EXIT_MS + 10_000);
	}, 120_000);

	// The ensure's attach hold (senpi#2227) is the readiness connection itself, whose request is UNMARKED:
	// it must count as an attachment although marked status reads around it do not.
	it("keeps a host held by an unreleased ensure alive under status polling, then idles it out once released", async () => {
		const qa = endpointScratch("hold");
		const ensured = await heldRealHost(qa, qa.shard, { idleExitMs: IDLE_EXIT_MS });
		const heldUntil = Date.now() + 2 * IDLE_EXIT_MS + POLL_INTERVAL_MS;
		let heldPolls = 0;
		while (Date.now() < heldUntil) {
			const { endpoints } = await statusAll(qa);
			if (endpoints.some((endpoint) => endpoint.reachable)) heldPolls++;
			await delay(POLL_INTERVAL_MS);
		}
		expect(processAlive(ensured.pid)).toBe(true);
		expect(heldPolls).toBeGreaterThanOrEqual(4);

		ensured.release();
		const releasedAt = Date.now();
		let exited: boolean | undefined;
		const exit = waitForPidGone(ensured.pid, 10 * IDLE_EXIT_MS).then((gone) => {
			exited = gone;
		});
		while (exited === undefined) {
			await statusAll(qa);
			await Promise.race([exit, delay(POLL_INTERVAL_MS)]);
		}

		expect(exited).toBe(true);
		expect(Date.now() - releasedAt).toBeLessThan(IDLE_EXIT_MS + 10_000);
	}, 120_000);

	it("lets a bare socket host empty-exit on schedule while one open connection keeps observing it", async () => {
		const qa = endpointScratch("obs");
		const host = await bareSocketHost(qa, qa.legacy, IDLE_EXIT_MS);
		const startedAt = Date.now();
		const observer = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(observer);
		let exited: boolean | undefined;
		const exit = waitForPidGone(host, 10 * IDLE_EXIT_MS).then((gone) => {
			exited = gone;
		});
		let answered = 0;
		for (let read = 0; exited === undefined && !observer.closed; read++) {
			// The host may close this connection mid-read when it exits: that read then never answers.
			const answer = await Promise.race([
				observer
					.request({ id: `observe-${read}`, type: "get_protocol_info", observe: true }, 5_000)
					.catch(() => undefined),
				exit.then(() => undefined),
			]);
			if (answer?.type === "response" && answer.success === true) answered++;
			await Promise.race([exit, delay(POLL_INTERVAL_MS)]);
		}
		await exit;

		expect(exited).toBe(true);
		expect(answered).toBeGreaterThanOrEqual(2);
		expect(Date.now() - startedAt).toBeLessThan(IDLE_EXIT_MS + 10_000);
	}, 120_000);
});
