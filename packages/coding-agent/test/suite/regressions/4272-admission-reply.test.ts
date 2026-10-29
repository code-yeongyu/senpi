import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withAdmissionRequest } from "../../../src/modes/rpc/compact-admission-reply.ts";
import { statusHost } from "../rpc-session-status-support.ts";

afterEach(() => vi.unstubAllEnvs());

// #4272 / RULING-92: the writer must enforce ownership even if its caller selects the wrong socket.
it("drops foreign and unmatched replies instead of delivering untagged or guessing the first route", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const foreign = host.client("foreign");
	const sessionPath = join(host.cwd, "replies.jsonl");
	const opened = await peer.request({ type: "open_session", sessionPath, admissionId: "a" });
	await peer.request({ type: "open_session", sessionPath, admissionId: "b" });
	await foreign.request({ type: "open_session", sessionPath, admissionId: "foreign" });
	const sessionId = String(opened.sessionId);
	const reset = await peer.request({ type: "reset_stream", sessionId, admissionId: "b" });
	const reply = { id: "request", type: "response", command: "get_state", success: true, sessionId };
	const request = { id: "request", type: "get_state", sessionId, admissionId: "b" } as const;
	const fromPeer = peer.inbox.length;
	const fromForeign = foreign.inbox.length;
	await withAdmissionRequest(request, "peer", () => host.writer.enqueueControl(reply, "foreign"));
	await withAdmissionRequest({ ...request, id: "different" }, "peer", () => host.writer.enqueueControl(reply, "peer"));
	await host.writer.enqueueControl(reply, "peer");
	await withAdmissionRequest({ ...request, admissionId: "missing" }, "peer", () =>
		host.writer.enqueueControl(reply, "peer"),
	);
	await host.writer.flush();
	expect(foreign.inbox.slice(fromForeign).filter((frame) => frame.type === "response")).toEqual([]);
	expect(peer.inbox.slice(fromPeer).filter((frame) => frame.type === "response")).toEqual([]);
	await withAdmissionRequest(request, "peer", () => host.writer.enqueueControl(reply, "peer"));
	await host.writer.flush();
	expect(peer.inbox.slice(fromPeer).filter((frame) => frame.type === "response")).toEqual([
		{ ...reply, admissionId: "b", generation: reset.generation },
	]);
}, 120_000);

it("keeps flag-off response bytes unchanged even with foreign or absent request scope", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "0");
	await using host = await statusHost();
	const peer = host.client("peer");
	const opened = await peer.request({ type: "open_session", sessionPath: join(host.cwd, "legacy.jsonl") });
	const reply = { id: "legacy", type: "response", command: "get_state", success: true, sessionId: opened.sessionId };
	const from = peer.received.length;
	await withAdmissionRequest({ type: "get_state", id: "other" }, "foreign", () =>
		host.writer.enqueueControl(reply, "peer"),
	);
	await host.writer.enqueueControl(reply, "peer");
	await host.writer.flush();
	expect(peer.received.slice(from)).toEqual([`${JSON.stringify(reply)}\n`, `${JSON.stringify(reply)}\n`]);
}, 120_000);
