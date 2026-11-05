import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { socketSink } from "../../../src/modes/rpc/socket-sink.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { maskServerIdentity, replaceRoot } from "./4272-admission-golden-support.ts";
import { listenOnShortSocket } from "./4272-rpc-client-admission-support.ts";

const FIXTURES = new URL("../../../docs/engine-socket/fixtures/admission-routes/", import.meta.url);
const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// Only run-owned paths, random IDs (including the faux API) and the public nonce are normalized, without parsing/re-serializing
// frames: fields, ordering, framing and payload bytes otherwise stay untouched.
function normalize(bytes: string, root: string): string {
	const ids = new Map<string, string>();
	const uuid = replaceRoot(bytes, root).replace(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
		(id) => {
			if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
			return ids.get(id) ?? id;
		},
	);
	const entries = new Map<string, string>();
	return uuid
		.replace(/("(?:id|parentId|leafId)":")([0-9a-f]{8})(")/g, (_all, before: string, id: string, after: string) => {
			if (!entries.has(id)) entries.set(id, `<entry-${entries.size + 1}>`);
			return `${before}${entries.get(id)}${after}`;
		})
		.replace(/("api":")faux:[^"]+(")/g, "$1faux:fixture$2")
		.replace(/("client_nonce":")[0-9a-f]{64}(")/g, "$1<public-nonce>$2");
}

async function record(flag: "0" | "1"): Promise<Record<string, string>> {
	vi.stubEnv(FLAG, flag);
	await using host = await statusHost();
	const requests: string[] = [];
	const frames: string[] = [];
	const handlers: Promise<void>[] = [];
	const failures: unknown[] = [];
	const server = createServer((socket) => {
		const sink = socketSink(socket);
		host.writer.registerConnection("rpc-client", {
			...sink,
			writeRaw: (line) => {
				frames.push(line);
				sink.writeRaw(line);
			},
		});
		attachJsonlLineReader(socket, (line) => {
			requests.push(`${line}\n`);
			const handled = host.writer.withConnection("rpc-client", () => host.core.handle(line));
			handlers.push(handled);
			void handled.catch((cause: unknown) => failures.push(cause));
		});
	});
	const listener = await listenOnShortSocket(server, "golden.sock");
	const client = new RpcClient({ socketPath: listener.socketPath });
	const subscriber = host.client("subscriber");
	try {
		await client.start();
		await client.setClientInfo(100, []);
		const subscribed = await subscriber.request({ type: "subscribe_sessions", mirror: "all" });
		await client.openSession({ cwd: host.cwd, sessionPath: join(host.cwd, "session.jsonl") });
		await client.getEntries();
		await client.closeSession();
		await subscriber.request({
			type: "unsubscribe_sessions",
			subscriptionId: dataOf(subscribed).subscriptionId,
		});
		await host.writer.flush();
		await Promise.all(handlers);
		expect(failures).toEqual([]);
		const root = dirname(host.cwd);
		return {
			rpcClientRequests: normalize(requests.join(""), root),
			rpcClientFrames: normalize(frames.join(""), root),
			subscribeRequests: normalize(subscriber.sent.join(""), root),
			subscribeFrames: normalize(subscriber.received.join(""), root),
		};
	} finally {
		await client.stop();
		host.writer.unregisterConnection("rpc-client");
		await host.core.router.releaseConnection("rpc-client");
		await listener.close();
	}
}

it("T7/X06 golden h: absent admissionId preserves every legacy producer frame and RpcClient request byte", async () => {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T00:00:00.000Z") });
	const legacy = await record("0");
	const absent = await record("1");
	// Discovery advertises the new opt-in; all unselected content and request bytes remain unchanged.
	const pair = ["compact_message_updates_v1", "event_resync"];
	const oldInfo = JSON.parse(legacy.rpcClientFrames.split("\n")[0]);
	const lines = absent.rpcClientFrames.trimEnd().split("\n");
	const info = JSON.parse(lines[0]);
	expect(info.data.capabilities).toEqual([
		...oldInfo.data.capabilities,
		...pair.filter((cap) => !oldInfo.data.capabilities.includes(cap)),
	]);
	info.data.capabilities = info.data.capabilities.filter(
		(cap: string) => !pair.includes(cap) || oldInfo.data.capabilities.includes(cap),
	);
	lines[0] = JSON.stringify(info);
	absent.rpcClientFrames = lines.join("\n") + "\n";
	// The fixture pins the frames, not the release's serverVersion or its capability list (see maskServerIdentity).
	const pinned = Object.fromEntries(Object.entries(legacy).map(([name, bytes]) => [name, maskServerIdentity(bytes)]));
	if (process.env.SENPI_PRINT_ADMISSION_GOLDEN === "1")
		console.log(`ADMISSION_GOLDEN_H ${JSON.stringify(pinned)}`, JSON.stringify({ legacy, absent }));
	expect(absent).toEqual(legacy);
	expect(Object.values(legacy).every((bytes) => bytes.length > 0)).toBe(true);
	expect(JSON.stringify(legacy)).not.toContain("admissionId");
	const fixture = JSON.parse(await readFile(new URL("h-legacy.json", FIXTURES), "utf8")) as unknown;
	expect(pinned).toEqual(fixture);
	const index = JSON.parse(await readFile(new URL("index.json", FIXTURES), "utf8")) as { cases: string[] };
	expect(index.cases).toContain("h-legacy.json");
	const manifest = JSON.parse(await readFile(new URL("../../../../package.json", FIXTURES), "utf8")) as {
		files: string[];
	};
	expect(manifest.files).toContain("docs");
}, 600_000);
