import { afterEach, expect, it, vi } from "vitest";
import { CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { MIRROR_PENDING_LIMITS } from "../../../src/modes/rpc/compact-mirror-pending.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each(["activation", "cancel", "supersession", "peer end", "epoch retirement"])(
	"T2/Y07 %s releases the real subscription's pending buffer without touching its sibling",
	async (operation) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		const owner = host.client("owner");
		const opened = await owner.request({ type: "open_session", cwd: host.cwd });
		const sessionId = String(dataOf(opened).sessionId);
		const sibling = await peer.request({ type: "subscribe_sessions", admissionId: "sibling", mirror: "all" });
		const siblingId = String(dataOf(sibling).subscriptionId);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let ledger: CompactAdmissions | undefined;
		let serverId = "";
		const subscribe = host.writer.status.subscribe;
		vi.spyOn(host.writer.status, "subscribe").mockImplementationOnce((...args) => {
			const result = subscribe.apply(host.writer.status, args);
			serverId = result.subscriptionId;
			return result;
		});
		const run = CompactAdmissions.prototype.run;
		vi.spyOn(CompactAdmissions.prototype, "run").mockImplementationOnce(function (
			this: CompactAdmissions,
			identity,
			produce,
		) {
			ledger = this;
			return run.call(this, identity, async (signal) => {
				const value = await produce(signal);
				entered.resolve();
				await finish.promise;
				return value;
			});
		});
		const handled = host.writer.withConnection("peer", () =>
			host.core.handle(
				JSON.stringify({
					id: "pending",
					type: "subscribe_sessions",
					admissionId: "pending",
					mirror: "all",
				}),
			),
		);
		try {
			await entered.promise;
			const buffer = host.writer.status.pendingBuffer(serverId) ?? expect.unreachable("no real pending buffer");
			host.writer.enqueue(sessionId, { type: "agent_start" });
			expect(buffer.status().entries).toBeGreaterThan(0);
			let ending: Promise<void> | undefined;
			if (operation === "cancel") {
				expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "pending" }))).toEqual({
					outcome: "cancelled",
				});
				expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "pending" }))).toEqual({
					outcome: "cancelled",
				});
			} else if (operation === "supersession") {
				await peer.request({ type: "unsubscribe_sessions", subscriptionId: serverId });
			} else if (operation === "peer end") {
				ending = host.drop("peer");
			} else if (operation === "epoch retirement") {
				ending = ledger?.forgetPeer(host.writer.socketEpochOf("peer") ?? expect.unreachable());
			}
			finish.resolve();
			await handled;
			await ending;
			await host.writer.flush();
			expect(buffer.status()).toEqual({ entries: 0, bytes: 0 });
			const response = peer.inbox.find((frame) => frame.id === "pending");
			if (operation === "activation") {
				expect(response).toMatchObject({ success: true, admissionId: "pending" });
				const manifest = peer.inbox.find(
					(frame) => frame.type === "recovery_manifest" && frame.admissionId === "pending",
				);
				const suffix = peer.inbox.find((frame) => frame.type === "agent_start" && frame.admissionId === "pending");
				expect(manifest).toBeDefined();
				expect(suffix).toBeDefined();
				expect(peer.inbox.indexOf(response ?? {})).toBeLessThan(peer.inbox.indexOf(manifest ?? {}));
				expect(peer.inbox.indexOf(manifest ?? {})).toBeLessThan(peer.inbox.indexOf(suffix ?? {}));
			} else {
				expect(host.writer.isCompactSubscription("peer", "pending", serverId)).toBe(false);
				expect(peer.inbox.some((frame) => frame.type === "agent_start" && frame.admissionId === "pending")).toBe(
					false,
				);
				if (operation === "cancel" || operation === "supersession")
					expect(response).toMatchObject({ success: false });
			}
			if (operation !== "peer end")
				expect(host.writer.status.connectionSize("peer")).toBe(operation === "activation" ? 2 : 1);
			if (operation === "cancel" || operation === "supersession")
				expect(host.writer.isCompactSubscription("peer", "sibling", siblingId)).toBe(true);
		} finally {
			finish.resolve();
			await handled;
		}
	},
	120_000,
);

it.each(["entries", "bytes"])(
	"T2/X04 actual %s overflow refuses without activation and replays its outcome",
	async (bound) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let serverId = "";
		const subscribe = host.writer.status.subscribe;
		vi.spyOn(host.writer.status, "subscribe").mockImplementationOnce((...args) => {
			const result = subscribe.apply(host.writer.status, args);
			serverId = result.subscriptionId;
			return result;
		});
		const run = CompactAdmissions.prototype.run;
		vi.spyOn(CompactAdmissions.prototype, "run").mockImplementationOnce(function (
			this: CompactAdmissions,
			identity,
			produce,
		) {
			return run.call(this, identity, async (signal) => {
				const value = await produce(signal);
				entered.resolve();
				await finish.promise;
				return value;
			});
		});
		const command = { type: "subscribe_sessions", admissionId: "overflow", mirror: "all" };
		const pending = peer.request(command);
		try {
			await entered.promise;
			const buffer = host.writer.status.pendingBuffer(serverId) ?? expect.unreachable();
			const line = bound === "bytes" ? "x".repeat(MIRROR_PENDING_LIMITS.bytes) : "x";
			const count = bound === "bytes" ? 2 : MIRROR_PENDING_LIMITS.entries + 1;
			for (let index = 0; index < count; index++)
				buffer.enqueue(line, () => expect.unreachable("overflow activated"));
			finish.resolve();
			const first = await pending;
			const second = await peer.request(command);
			expect(first).toMatchObject({ success: false, errorData: { reason: "admission_limit" } });
			expect({ ...second, id: first.id }).toEqual(first);
			expect(buffer.status()).toEqual({ entries: 0, bytes: 0 });
			expect(host.writer.status.connectionSize("peer")).toBe(0);
			expect(host.writer.recoveryEvents?.status().open).toBe(0);
			expect(peer.inbox.some((frame) => frame.type === "recovery_manifest")).toBe(false);
		} finally {
			finish.resolve();
			await pending;
		}
	},
	120_000,
);
