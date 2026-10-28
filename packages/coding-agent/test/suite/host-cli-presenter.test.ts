import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { HeldAnthropicModel, openedSessionId } from "../helpers/rpc-generation-support.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { enrollmentRequest } from "../mcp/fixtures/presenter-enrollment.ts";
import {
	acknowledgedRequest,
	authenticated,
	bootstrap,
	connected,
	enroll,
	hostCloses,
	next,
	peerRecord,
	send,
	signature,
} from "./host-cli-presenter-support.ts";
import { hostCliSandbox, onlyJsonLine, runHostCli, sweepHostCliSandboxes } from "./host-cli-support.ts";
import { Peer, type Wire } from "./rpc-public-auth-harness.ts";

const sockets: Socket[] = [];
const models: HeldAnthropicModel[] = [];
const enforcement = ["--mcp-presenter-enforcement", "--mcp-presenter-fd", "4"];
/** The running test's own signal: every wait below ends on a host or channel event, or with the test (#4652). */
let signal: AbortSignal;

beforeEach((context) => {
	signal = context.signal;
});

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const model of models) model.release();
	await sweepHostCliSandboxes();
	for (const model of models.splice(0)) await model.close();
}, 120_000);

async function privateSocket(endpoint: unknown): Promise<Socket> {
	if (typeof endpoint !== "string") throw new Error("missing management endpoint");
	const socket = connect(endpoint);
	sockets.push(socket);
	await connected(socket, "the management endpoint", signal);
	return socket;
}

async function launched(
	qa: Awaited<ReturnType<typeof hostCliSandbox>>,
	args: string[],
	options: { runtime?: string; predecessor?: unknown } = {},
) {
	let enrolled: Wire | undefined;
	const result = await runHostCli(qa, args, { SENPI_RUNTIME: options.runtime ?? "bun" }, async (socket) => {
		enrolled = await bootstrap(socket, signal, options.predecessor);
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(enrolled).toMatchObject({ type: "enrolled", backendGeneration: enroll.backendGeneration });
	if (!enrolled) throw new Error("CLI exited without presenter enrollment");
	return { payload: onlyJsonLine(result), enrolled };
}

async function heldModel(qa: Awaited<ReturnType<typeof hostCliSandbox>>) {
	const model = await HeldAnthropicModel.start();
	models.push(model);
	writeRpcModelsJson(qa.agentDir, model.origin);
	return model;
}

async function busy(qa: Awaited<ReturnType<typeof hostCliSandbox>>) {
	const peer = await Peer.connect(qa.socket);
	sockets.push(peer.socket);
	await authenticated(peer, qa.agentDir, signal);
	const sessionId = openedSessionId(
		await acknowledgedRequest(
			peer,
			{ id: "open", type: "open_session", cwd: qa.root, provider: MOCK_PROVIDER, modelId: MOCK_MODEL },
			signal,
		),
	);
	const accepted = peer.records.length;
	await acknowledgedRequest(peer, { id: "prompt", type: "prompt", sessionId, message: "hold this turn" }, signal);
	await peerRecord(peer, (record) => record.type === "agent_start", "agent_start", signal, accepted);
	return { peer, sessionId };
}

// #4247: all launches enter the PUBLIC source CLI, not a bootstrap-only relay fixture.
describe.skipIf(process.platform === "win32")("public host presenter deployment option", () => {
	it.each(["node", "bun"])(
		"host ensure reaches enrolled with explicit enforcement and fd 4 (%s)",
		async (runtime) => {
			const qa = await hostCliSandbox("pe");
			const { payload } = await launched(qa, ["ensure", ...enforcement], { runtime });
			expect(payload).toMatchObject({ action: "start", reused: false });
			expect(payload.capabilities).toContain("mcp_form_presenter_v1");
			const paths = createHostDaemonPaths({ agentDir: qa.agentDir, socket: qa.socket });
			expect(await readFile(paths.settingsFile, "utf8")).not.toContain("presenter");
		},
		120_000,
	);

	it.each([true, false])(
		"immediate handoff preserves enforcement and requires fresh enrollment (explicit %s)",
		async (explicit) => {
			const qa = await hostCliSandbox("pi");
			const first = await launched(qa, ["ensure", ...enforcement]);
			const second = await launched(qa, ["handoff", ...(explicit ? enforcement : ["--mcp-presenter-fd", "4"])], {
				predecessor: first.enrolled.hostInstance,
			});
			expect(second.payload).toMatchObject({ action: "handoff", generation: 1 });
			expect(second.payload.capabilities).toContain("mcp_form_presenter_v1");
			expect(second.enrolled.hostInstance).not.toBe(first.enrolled.hostInstance);
			expect(second.enrolled.principalId).not.toBe(first.enrolled.principalId);
			const stale = await privateSocket(second.enrolled.endpoint);
			const frames: string[] = [];
			stale.on("data", (chunk) => frames.push(String(chunk)));
			const closed = hostCloses(stale, "the stale management channel", signal);
			const challenge = (principalId: unknown) => ({
				type: "challenge",
				principalId,
				backendGeneration: enroll.backendGeneration,
				command: { type: "mcp_presenter_assign" },
			});
			// Promptness by order: the host refuses AT the stale record, so the current principal's challenge
			// right behind it on the same channel is never answered (a host that let it pass would answer it).
			send(stale, challenge(first.enrolled.principalId));
			send(stale, challenge(second.enrolled.principalId));
			await closed;
			expect(frames).toEqual([]);
		},
		180_000,
	);

	// #4254 review: the immediate route signs the predecessor, so it must be the host actually replaced.
	it.each(["foreign", "stale"] as const)(
		"immediate handoff refuses a %s predecessor without enrolling the successor",
		async (kind) => {
			const qa = await hostCliSandbox(kind === "foreign" ? "pf" : "ps");
			const first = await launched(qa, ["ensure", ...enforcement]);
			const current =
				kind === "stale"
					? (await launched(qa, ["handoff", ...enforcement], { predecessor: first.enrolled.hostInstance }))
							.enrolled.hostInstance
					: first.enrolled.hostInstance;
			const claimed = kind === "foreign" ? randomUUID() : first.enrolled.hostInstance;
			expect(claimed).not.toBe(current);
			const frames: string[] = [];
			const result = await runHostCli(qa, ["handoff", ...enforcement], {}, async (socket) => {
				socket.on("data", (chunk) => frames.push(String(chunk)));
				const closed = hostCloses(socket, "the refused bootstrap channel", signal);
				send(socket, enrollmentRequest({ launchKind: "replacement", predecessorHostInstance: claimed }));
				await closed;
			});
			expect(frames).toEqual([]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(onlyJsonLine(result)).toMatchObject({ action: "handoff" });
		},
		240_000,
	);

	it.each([true, false])(
		"deferred handoff preserves enforcement and requires fresh enrollment (previously enrolled %s)",
		async (owned) => {
			const qa = await hostCliSandbox("pd");
			const model = await heldModel(qa);
			const first = owned
				? await launched(qa, ["ensure", ...enforcement])
				: { payload: onlyJsonLine(await runHostCli(qa, ["ensure"])), enrolled: undefined };
			const { peer, sessionId } = await busy(qa);
			let management: Socket | undefined;
			if (first.enrolled) {
				const context = peerRecord(peer, (record) => record.id === "context", "the presenter context", signal);
				send(peer.socket, { id: "context", type: "mcp_presenter_context", sessionId });
				management = await privateSocket(first.enrolled.endpoint);
				const challenge = next(management, "challenge", signal);
				send(management, {
					type: "challenge",
					principalId: first.enrolled.principalId,
					backendGeneration: enroll.backendGeneration,
					command: {
						type: "mcp_presenter_assign",
						sessionId,
						bindingEpoch: ((await context).context as Wire).bindingEpoch,
						purpose: "mcp_form",
					},
				});
				const proof = signature((await challenge).transcript);
				const assigned = next(management, "mcp_presenter_assigned", signal);
				send(management, { type: "proof", signature: proof });
				await assigned;
			}
			await writeFile(join(qa.specDir, "next.mjs"), "export default function () {}\n");
			const spec = join(qa.specDir, "next.json");
			await writeFile(
				spec,
				JSON.stringify({
					spec_version: 1,
					core: { session_runtime: "in-process", multi_session: true, extensions: ["next.mjs"] },
				}),
				{ mode: 0o600 },
			);
			// An ensure reports THIS CLI's target build while reusing the busy generation, never enrolling it.
			const target = onlyJsonLine(await runHostCli(qa, ["ensure", "--policy", "never", "--launch-spec", spec]));
			const pending = await runHostCli(qa, [
				"handoff",
				"--when",
				"idle",
				"--operation",
				"presenter-4247",
				"--if-instance",
				String(first.payload.instanceId),
				"--if-generation",
				"0",
				"--target-build",
				String(target.clientRuntimeBuildId),
				"--launch-spec",
				spec,
				"--mcp-presenter-enforcement",
			]);
			expect(pending.exitCode, pending.stderr).toBe(0);
			expect(onlyJsonLine(pending).action).toBe("handover_pending");
			const successorPrepare = management ? next(management, "mcp_presenter_successor_prepare", signal) : undefined;
			// The handover was acknowledged (`handover_pending`): the host finishes the turn, starts and proves
			// the successor within its own budgets, then announces. Read through the peer's own parser.
			const superseded = peerRecord(peer, (record) => record.type === "host_superseded", "host_superseded", signal);
			model.release();
			if (successorPrepare && management && first.enrolled) {
				const preparation = await successorPrepare;
				expect(preparation.predecessorHostInstance).toBe(first.enrolled.hostInstance);
				const authorization = enrollmentRequest({
					launchKind: "replacement",
					predecessorHostInstance: first.enrolled.hostInstance,
				});
				expect(authorization.launchRequestNonce).not.toBe(first.enrolled.launchRequestNonce);
				const successorChallenge = next(management, "mcp_presenter_successor_challenge", signal);
				send(management, {
					type: "mcp_presenter_successor_authorize",
					id: preparation.id,
					enrollment: authorization,
				});
				const request = await successorChallenge;
				const fresh = request.challenge as Wire;
				expect(fresh.hostInstance).not.toBe(first.enrolled.hostInstance);
				const tuple = JSON.parse(String(fresh.transcript));
				expect(tuple[4]).toBe(authorization.launchRequestNonce);
				expect(tuple[5]).toBe("replacement");
				expect(tuple[6]).toBe(first.enrolled.hostInstance);
				expect(tuple[9]).toBe(fresh.hostInstance);
				expect(tuple).toHaveLength(12);
				const successorEnrolled = next(management, "mcp_presenter_successor_enrolled", signal);
				send(management, {
					type: "mcp_presenter_successor_proof",
					id: request.id,
					signature: signature(fresh.transcript),
				});
				const enrollment = (await successorEnrolled).enrollment as Wire;
				expect(enrollment.hostInstance).toBe(fresh.hostInstance);
				expect(enrollment.launchRequestNonce).toBe(authorization.launchRequestNonce);
				expect(enrollment.principalId).not.toBe(first.enrolled.principalId);
			}
			await superseded;
			const after = onlyJsonLine(await runHostCli(qa, ["status"]));
			expect(after.capabilities).toContain("mcp_form_presenter_v1");
			expect(after.runtimeBuildId).toBe(target.clientRuntimeBuildId);
		},
		240_000,
	);

	it("fd 4 without the deployment option never enrolls or enables enforcement", async () => {
		const qa = await hostCliSandbox("pf");
		const received: string[] = [];
		const result = await runHostCli(qa, ["ensure", "--mcp-presenter-fd", "4"], {}, async (socket) => {
			socket.on("error", () => {});
			socket.on("data", (chunk) => received.push(String(chunk)));
			send(socket, enroll);
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(onlyJsonLine(result).capabilities).not.toContain("mcp_form_presenter_v1");
		expect(received).toEqual([]);
	}, 120_000);

	it("reuse does not enroll or upgrade a foreign busy host; default remains off", async () => {
		const qa = await hostCliSandbox("pr");
		const model = await heldModel(qa);
		const first = onlyJsonLine(await runHostCli(qa, ["ensure"]));
		expect(first.capabilities).not.toContain("mcp_form_presenter_v1");
		const { peer } = await busy(qa);
		const received: string[] = [];
		const reused = await runHostCli(qa, ["ensure", ...enforcement], {}, async (socket) => {
			socket.on("error", () => {});
			socket.on("data", (chunk) => received.push(String(chunk)));
			send(socket, enroll);
		});
		expect(reused.exitCode, reused.stderr).toBe(0);
		expect(onlyJsonLine(reused)).toMatchObject({
			action: "reuse",
			reused: true,
			pid: first.pid,
			instanceId: first.instanceId,
		});
		expect(onlyJsonLine(reused).capabilities).not.toContain("mcp_form_presenter_v1");
		expect(received).toEqual([]);
		const ended = peerRecord(peer, (record) => record.type === "agent_end", "agent_end", signal);
		model.release();
		await ended;
	}, 180_000);
});
