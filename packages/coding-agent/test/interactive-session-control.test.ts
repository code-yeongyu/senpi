import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyEndpointLiveness } from "../src/modes/rpc/host-endpoint-liveness.ts";
import { listHostEndpoints } from "../src/modes/rpc/host-endpoints.ts";
import { socketSecretPath } from "../src/modes/rpc/socket-transport.ts";
import { controlData, controlRequest } from "./helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "./helpers/session-control-fixture.ts";

const fixtures: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

async function endpoint(options: Parameters<typeof startEndpoint>[0] = {}): Promise<EndpointFixture> {
	const fixture = await startEndpoint(options);
	fixtures.push(fixture);
	return fixture;
}

describe("TUI session control endpoint", () => {
	it("registers as a routable tui endpoint and removes its directory on dispose", async () => {
		const fixture = await endpoint();
		expect(fixture.socket).toMatch(/\/(rpc|senpi-rpc-[0-9a-f]{8})\/tui\/t-[0-9a-f]{16}\.sock$/);
		expect(statSync(fixture.socket).mode & 0o777).toBe(0o600);
		expect(statSync(socketSecretPath(fixture.socket)).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(fixture.socket)).mode & 0o777).toBe(0o700);
		const [entry, ...rest] = await listHostEndpoints(fixture.agentDir);
		expect(rest).toEqual([]);
		expect(entry).toMatchObject({ endpoint_kind: "tui", socket: fixture.socket, identity: "endpoint" });
		if (entry === undefined) throw new Error("no endpoint listed");
		expect(await classifyEndpointLiveness(entry)).toBe("routable");

		await fixture.endpoint.dispose();
		expect(existsSync(entry.dir)).toBe(false);
		expect(existsSync(fixture.socket)).toBe(false);
		expect(await listHostEndpoints(fixture.agentDir)).toEqual([]);
	});

	it("refuses a wrong secret before answering any JSONL command", async () => {
		const fixture = await endpoint();
		const reply = await controlRequest(fixture.socket, { type: "get_protocol_info" }, Buffer.alloc(32, 7));
		expect(reply).toEqual({ kind: "closed", bytes: 0 });
		const info = await controlData(fixture.socket, { type: "get_protocol_info" });
		expect(info).toMatchObject({ protocolVersion: 1, capabilities: ["tui_control"], mode: "tui" });
	});

	it("answers commands outside the allowlist as unsupported data, prompt included", async () => {
		const fixture = await endpoint();
		for (const type of ["prompt", "steer", "follow_up", "open_session", "bash", "abort", "cycle_model", "nope"]) {
			const reply = await controlRequest(fixture.socket, { type, message: "hi" });
			expect(reply.kind === "answered" && reply.record).toMatchObject({ success: false, error: "unsupported" });
		}
		expect(fixture.harness.session.messages).toEqual([]);
	});

	it("serves one session row and the extended state", async () => {
		const fixture = await endpoint();
		const listing = await controlData(fixture.socket, { type: "list_sessions" });
		expect(listing).toMatchObject({
			sessions: [{ sessionId: fixture.harness.session.sessionId, kind: "interactive", surface: "tui" }],
		});
		const state = await controlData(fixture.socket, { type: "get_state" });
		expect(state).toMatchObject({
			turn_epoch: 0,
			blocking_question: false,
			compacting: false,
			editor_has_draft: false,
		});
		fixture.setDraft("draft");
		expect(await controlData(fixture.socket, { type: "get_state" })).toMatchObject({ editor_has_draft: true });
		expect(await controlData(fixture.socket, { type: "set_session_name", name: "tui-one" })).toBeUndefined();
		expect(fixture.harness.session.sessionName).toBe("tui-one");
	});

	it("wake runs the drain and answers its admissions; nothing pending answers admitted: []", async () => {
		const fixture = await endpoint({
			drain: (event) =>
				event.delivery_ids?.includes("d2") ? { admitted: [{ delivery_id: "d2", kind: "started" }] } : undefined,
		});
		expect(await controlData(fixture.socket, { type: "wake" })).toEqual({ admitted: [] });
		expect(await controlData(fixture.socket, { type: "wake", delivery_ids: ["d2"] })).toEqual({
			admitted: [{ delivery_id: "d2", kind: "started" }],
		});
		expect(fixture.wakes.at(-1)).toMatchObject({ reason: "command", delivery_ids: ["d2"] });
	});

	it("wakes the drain with reason inbox when an entry is created in the inbox", async () => {
		const fixture = await endpoint();
		const marker = join(fixture.inboxDir, "d-inbox");
		const woken = fixture.nextWake("inbox", () => existsSync(marker));
		writeFileSync(marker, "marker");
		expect((await woken).reasons).toContain("inbox");
	});

	it("wakes the drain with reason continue after SIGCONT", async () => {
		const fixture = await endpoint();
		const woken = fixture.nextWake("continue");
		process.emit("SIGCONT");
		expect((await woken).reason).toBe("continue");
	});

	it("streams state events to a subscriber from its cursor", async () => {
		const fixture = await endpoint();
		expect(await controlData(fixture.socket, { type: "subscribe" })).toEqual({ cursor: 0 });
		fixture.endpoint.noteState();
		const replay = await controlRequest(fixture.socket, { type: "subscribe", cursor: 0 });
		expect(replay.kind === "answered" && replay.record.data).toEqual({ cursor: 1 });
	});
});
