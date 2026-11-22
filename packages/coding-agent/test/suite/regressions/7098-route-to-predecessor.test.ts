import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHostDaemonPaths, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { PredecessorPeer } from "../../../src/modes/rpc/predecessor-peer.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	HeldAnthropicModel,
	JsonlPeer,
	openedSessionId,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";

it.skipIf(process.platform === "win32").each(["park", "exit"] as const)(
	"routes a detached turn, then keeps the handle after predecessor %s",
	async (transition) => {
		const qa = generationScratch("route");
		const model = await HeldAnthropicModel.start();
		const peers: JsonlPeer[] = [];
		async function connect() {
			const peer = await JsonlPeer.connect(qa.socket);
			peers.push(peer);
			return peer;
		}
		try {
			writeRpcModelsJson(qa.agentDir, model.origin);
			const launch = {
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS],
				env: generationEnv(qa),
				_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
			};
			const a = await ensureHost({ ...launch, policy: { idleExitMs: 600_000 } });
			const opener = await connect();
			const sessionPath = join(qa.sessionDir, "lane.jsonl");
			const durable = "70980000-0000-4000-8000-000000000001";
			await writeFile(
				sessionPath,
				`${JSON.stringify({ type: "session", version: 3, id: durable, timestamp: new Date(0).toISOString(), cwd: qa.cwd })}\n`,
			);
			const old = openedSessionId(
				await opener.request({ type: "open_session", id: "open", sessionPath, retain_on_disconnect: true }),
			);
			expect(
				await opener.request({ type: "prompt", id: "start", sessionId: old, message: "held on predecessor" }),
			).toMatchObject({ success: true });
			await model.requested;
			opener.destroy();
			const observer = await connect();
			const first = await observer.request({ type: "get_protocol_info", id: "which" });
			const firstInstance = (first.data as { instanceId: string }).instanceId;
			const dir = createHostDaemonPaths({ agentDir: qa.agentDir, socket: qa.socket });
			const generation = generationPaths(dir, firstInstance);
			const b = await handoffHost(launch);
			expect(b.action).toBe("handoff");
			if (transition === "park") {
				const endpoint = JSON.parse(await readFile(join(generation.dir, "route.json"), "utf8")) as {
					socket: string;
					launchId: string;
				};
				const unproven = await JsonlPeer.connect(endpoint.socket);
				peers.push(unproven);
				expect(await unproven.request({ id: "denied", type: "list_sessions" })).toMatchObject({
					success: false,
					error: "auth_required",
				});
				const checked = await PredecessorPeer.connect(
					{ ...endpoint, instanceId: firstInstance, keyRoot: qa.agentDir },
					() => {},
					() => {},
				);
				try {
					expect(
						await checked.request({
							type: "open_session",
							sessionPath: join(qa.sessionDir, "absent.jsonl"),
							expectedHostInstance: firstInstance,
						}),
					).toMatchObject({ success: false, error: "session_not_held" });
				} finally {
					checked.close();
				}
			}
			const client = await connect();
			const opened = await client.request({ type: "open_session", id: "route", sessionPath });
			expect(opened, JSON.stringify(opened)).toMatchObject({ success: true, data: { attached: true } });
			const sessionId = openedSessionId(opened);
			const list = async (id: string, generation: number) => {
				expect(await client.request({ id, type: "list_sessions" })).toMatchObject({
					data: { sessions: [{ sessionId, durableSessionId: durable, generation }] },
				});
			};
			await list("before", 0);
			const second = await connect();
			expect(
				await second.request({ type: "attach_session", id: "second", sessionId, durableSessionId: durable }),
			).toMatchObject({ success: true, data: { sessionId } });
			expect(await second.request({ type: "get_state", id: "read", sessionId })).toMatchObject({ success: true });
			expect(await second.request({ type: "release_attachment", id: "release", sessionId })).toMatchObject({
				success: true,
			});
			expect(
				await client.request({ type: "steer", id: "steer", sessionId, message: "route steering" }),
			).toMatchObject({ success: true });
			const queued = await observer.request({ type: "get_steering_messages", id: "on-a", sessionId: old });
			expect(queued).toMatchObject({ success: true, data: { messages: ["route steering"] } });
			const reads = await client.request({ type: "get_messages", id: "messages", sessionId });
			expect(reads.success).toBe(true);
			expect(JSON.stringify(reads.data)).toContain("held on predecessor");
			if (transition === "exit") {
				const file = generation.childPidFile;
				const { pid } = JSON.parse(await readFile(file, "utf8")) as { pid: number };
				expect(signalGeneration(pid, "SIGKILL")).toBe(true);
				await observer.waitForClose();
				model.release();
				// A read is safe to replay, so it waits for the switch; a mutation sent before the successor saw the
				// route break is refused rather than replayed (predecessor_delivery_outcome_unknown).
				expect(await client.request({ type: "get_state", id: "switched", sessionId })).toMatchObject({
					success: true,
				});
			} else {
				model.release();
				await client.waitFor((r) => r.type === "message_end" && r.sessionId === sessionId);
				await observer.waitFor(
					(r) => r.type === "session_closed" && r.sessionId === old && r.reason === "handoff_parked",
					60_000,
				);
			}
			expect(
				await client.request({ type: "prompt", id: "again", sessionId, message: "running on successor" }),
			).toMatchObject({ success: true });
			await client.waitFor(
				(r) => r.type === "agent_end" && JSON.stringify(r.messages).includes("running on successor"),
				30_000,
			);
			const continued = await client.request({ type: "get_messages", id: "continued", sessionId });
			if (transition === "park") expect(JSON.stringify(continued.data)).toContain("route steering");
			expect(await waitForPidGone(a.pid, 45_000)).toBe(true);
			await list("after", 1);
			expect(client.messages.filter((r) => r.type === "session_closed" && r.sessionId === sessionId)).toEqual([]);
			const entries = (await readFile(sessionPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { parentId?: string | null });
			const parents = entries.flatMap((entry) => (entry.parentId === undefined ? [] : [entry.parentId]));
			expect(new Set(parents).size).toBe(parents.length);
		} catch (cause) {
			throw new Error(
				peers
					.map(
						(p, i) =>
							`peer ${i}: ${p.messages
								.slice(-8)
								.map((r) => `${r.type}:${r.id ?? r.reason ?? ""}`)
								.join(", ")}`,
					)
					.join("\n"),
				{ cause },
			);
		} finally {
			for (const peer of peers) peer.destroy();
			model.release();
			await reapProcessesUnder(qa.root);
			await model.close();
			await rm(qa.root, { recursive: true, force: true, maxRetries: 10 });
		}
	},
);
