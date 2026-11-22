import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientOccupancy } from "../src/modes/rpc/host-client-occupancy.ts";
import { HOST_INSTANCE_ID_ENV } from "../src/modes/rpc/host-identity-env.ts";
import { ORIGIN_HOST_INSTANCE_FIELD, requestOriginHostInstance } from "../src/modes/rpc/host-observe-request.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { answerProtocolInfo } from "./helpers/rpc-legacy-protocol.ts";

const OWN = "own-generation";

function sent(occupancy: ClientOccupancy, request: Record<string, unknown>): Socket {
	const client = new Socket();
	occupancy.admit(client);
	client.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
	return client;
}

describe("ClientOccupancy origin classification (#3272)", () => {
	it("counts a client from its own generation as neither attached nor unclassified", () => {
		const occupancy = new ClientOccupancy(() => {}, OWN);
		sent(occupancy, { type: "list_sessions", [ORIGIN_HOST_INSTANCE_FIELD]: OWN });
		expect(occupancy.attachedCount).toBe(0);
		expect(occupancy.unclassifiedCount).toBe(0);
	});

	it.each([
		["another generation", { type: "list_sessions", [ORIGIN_HOST_INSTANCE_FIELD]: "other" }, OWN],
		["an unmarked client", { type: "list_sessions" }, OWN],
		["a host that knows no generation", { type: "list_sessions", [ORIGIN_HOST_INSTANCE_FIELD]: OWN }, undefined],
	])("attaches %s", (_case, request, own) => {
		let attached = 0;
		const occupancy = new ClientOccupancy(() => attached++, own);
		sent(occupancy, request);
		expect(occupancy.attachedCount).toBe(1);
		expect(attached).toBe(1);
	});

	it("releases a dependent without reporting an unclassified admission", () => {
		const occupancy = new ClientOccupancy(() => {}, OWN);
		const client = sent(occupancy, { type: "prompt", [ORIGIN_HOST_INSTANCE_FIELD]: OWN });
		expect(occupancy.release(client)).toBe(false);
		expect(occupancy.unclassifiedCount).toBe(0);
	});

	it("keeps an observing read an observer whatever its origin", () => {
		const occupancy = new ClientOccupancy(() => {}, OWN);
		sent(occupancy, { type: "get_protocol_info", observe: true });
		expect(occupancy.attachedCount).toBe(0);
		expect(occupancy.unclassifiedCount).toBe(0);
	});

	it("reads the origin only from a JSON object's string field", () => {
		expect(requestOriginHostInstance(JSON.stringify({ [ORIGIN_HOST_INSTANCE_FIELD]: OWN }))).toBe(OWN);
		expect(requestOriginHostInstance(JSON.stringify({ [ORIGIN_HOST_INSTANCE_FIELD]: 7 }))).toBeUndefined();
		expect(requestOriginHostInstance("[]")).toBeUndefined();
		expect(requestOriginHostInstance("not json")).toBeUndefined();
	});
});

describe("RpcClient origin marking (#3272)", () => {
	const roots: string[] = [];
	const servers: Server[] = [];
	const saved = process.env[HOST_INSTANCE_ID_ENV];
	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		if (saved === undefined) delete process.env[HOST_INSTANCE_ID_ENV];
		else process.env[HOST_INSTANCE_ID_ENV] = saved;
	});

	async function firstRequest(instance: string | undefined): Promise<Record<string, unknown>> {
		if (instance === undefined) delete process.env[HOST_INSTANCE_ID_ENV];
		else process.env[HOST_INSTANCE_ID_ENV] = instance;
		const root = mkdtempSync(join(tmpdir(), "origin-"));
		roots.push(root);
		const socketPath = join(root, "h.sock");
		const line = new Promise<string>((resolve) => {
			const server = createServer((peer) => {
				attachJsonlLineReader(peer, (frame) => {
					if (!answerProtocolInfo(peer, JSON.parse(frame))) resolve(frame);
				});
			});
			servers.push(server);
			server.listen(socketPath);
		});
		await once(servers[0] as Server, "listening");
		const client = new RpcClient({ socketPath });
		await client.start();
		void client.listSessions().catch(() => {});
		const request = JSON.parse(await line);
		await client.stop();
		return request;
	}

	it("names the host generation it runs inside on a socket request", async () => {
		expect(await firstRequest(OWN)).toMatchObject({ type: "list_sessions", [ORIGIN_HOST_INSTANCE_FIELD]: OWN });
	});

	it("sends no origin outside any host", async () => {
		expect(await firstRequest(undefined)).not.toHaveProperty(ORIGIN_HOST_INSTANCE_FIELD);
	});
});
