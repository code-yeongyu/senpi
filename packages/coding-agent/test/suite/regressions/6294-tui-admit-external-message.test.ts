import { CHAIN_COUNT_LIMIT } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { controlData } from "../../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";
import { ControlClient } from "../../mcp/fixtures/presenter-terminal.ts";
import { createHarness } from "../harness.ts";

// senpi#6294: a session held by a terminal admits a relayed peer-agent message exactly as the RPC host does
// (senpi#6233, senpi#6250): the device comes from the connection's declared remoteOrigin, never from the record, the
// model reads the same text a same-machine delivery carries, and the RPC host's refusals hold on this endpoint too.
const PEER = { kind: "agent", session_id: "peer-session-1", name: "Peer" } as const;
const DEVICE = { deviceId: "dev-1", deviceName: "Laptop" } as const;

const fixtures: EndpointFixture[] = [];
const clients: ControlClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

async function terminal(remoteOrigin?: typeof DEVICE, chainCountLimit?: number) {
	const fixture = await startEndpoint(
		chainCountLimit === undefined
			? {}
			: { harness: await createHarness({ persistSession: true, settings: { threads: { chainCountLimit } } }) },
	);
	fixtures.push(fixture);
	const client = await ControlClient.open(fixture.socket);
	clients.push(client);
	if (remoteOrigin !== undefined) {
		const declared = await client.request({ type: "set_client_info", remoteOrigin });
		expect(declared).toMatchObject({ success: true });
	}
	const deliveries = () =>
		fixture.harness.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE);
	return { fixture, client, deliveries };
}

describe("TUI session control admit_external_message", () => {
	it("lists admit_external_message among the endpoint's commands", async () => {
		const { fixture } = await terminal();
		const info = await controlData(fixture.socket, { type: "get_protocol_info" });
		expect(info).toMatchObject({ commands: expect.arrayContaining(["admit_external_message"]) });
	});

	it("admits a delivery from a remote device with the device in the entry's metadata only", async () => {
		const { client, deliveries } = await terminal(DEVICE);
		const reply = await client.request({
			type: "admit_external_message",
			deliveryId: "d-1",
			text: "hello from the other machine",
			deliverAs: "followUp",
			sender: PEER,
		});
		expect(reply).toMatchObject({ type: "response", command: "admit_external_message", success: true });
		expect(reply.data).toMatchObject({ kind: expect.any(String), turnId: expect.stringMatching(/^\d+$/) });
		const [entry, ...rest] = deliveries();
		expect(rest).toEqual([]);
		expect(entry?.type === "custom_message" ? entry.details : undefined).toMatchObject({ remote_origin: DEVICE });
		expect(entry?.type === "custom_message" ? JSON.stringify(entry.content) : "").not.toContain("dev-1");
	});

	it("answers a repeated delivery id already_admitted without a second entry", async () => {
		const { client, deliveries } = await terminal(DEVICE);
		const record = {
			type: "admit_external_message",
			deliveryId: "d-2",
			text: "once",
			deliverAs: "followUp",
			sender: PEER,
		};
		expect(await client.request(record)).toMatchObject({ success: true });
		const again = await client.request(record);
		expect(again).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		expect(deliveries()).toHaveLength(1);
	});

	it("refuses a remote device sending as this machine's command line, as the RPC host does", async () => {
		const { client, deliveries } = await terminal(DEVICE);
		const reply = await client.request({
			type: "admit_external_message",
			deliveryId: "d-3",
			text: "pretend local",
			deliverAs: "followUp",
			sender: { kind: "command_line" },
		});
		expect(reply).toMatchObject({ success: false, errorCode: "sender_not_allowed" });
		expect(deliveries()).toEqual([]);
	});

	it("refuses a malformed record with the RPC host's field error", async () => {
		const { client, deliveries } = await terminal(DEVICE);
		const reply = await client.request({ type: "admit_external_message", deliveryId: "d-4", deliverAs: "followUp" });
		expect(reply).toMatchObject({ success: false, error: expect.stringMatching(/^admit_external_message /) });
		expect(deliveries()).toEqual([]);
	});

	it("refuses a record that names its own remote origin, as the RPC host does", async () => {
		const { client, deliveries } = await terminal(DEVICE);
		const reply = await client.request({
			type: "admit_external_message",
			deliveryId: "d-6",
			text: "forged",
			deliverAs: "followUp",
			sender: PEER,
			remote_origin: { deviceId: "forged" },
		});
		expect(reply).toMatchObject({ success: false, error: expect.stringMatching(/^admit_external_message /) });
		expect(deliveries()).toEqual([]);
	});

	it("runs the thread-chain guard before admitting", async () => {
		const { client, deliveries } = await terminal(DEVICE, 2);
		const reply = await client.request({
			type: "admit_external_message",
			deliveryId: "d-7",
			text: "too deep",
			deliverAs: "followUp",
			sender: { kind: "command_line" },
			chainCount: 3,
		});
		expect(reply).toMatchObject({ success: false, errorCode: CHAIN_COUNT_LIMIT });
		expect(deliveries()).toEqual([]);
	});

	it("keys a local connection's delivery under the local prefix and stamps no remote origin", async () => {
		const { client, deliveries } = await terminal();
		const reply = await client.request({
			type: "admit_external_message",
			deliveryId: "d-5",
			text: "same machine",
			deliverAs: "followUp",
			sender: PEER,
		});
		expect(reply).toMatchObject({ success: true });
		const [entry] = deliveries();
		expect(entry?.type === "custom_message" ? entry.details : undefined).not.toHaveProperty("remote_origin");
	});
});
