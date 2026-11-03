import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { writeSession } from "./5374-call-key-fixture-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

// RULING-126 (1a) (senpi#5374): the call key is session-file data, never a wire mode. With the flag off, a session whose
// file carries call keys answers get_messages and get_entries with exactly the bytes the same session without them
// answers, and a second client attaching to it is replayed nothing that names a call key.
it("RULING-126 (1a) #5374 flag-off history and attach bytes are identical with and without persisted call keys", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "0");
	await using host = await statusHost();
	const shown = async (keyed: boolean) => {
		const sessionPath = writeSession(host.cwd, keyed, keyed ? "keyed.jsonl" : "plain.jsonl");
		const client = host.client(keyed ? "keyed" : "plain");
		const opened = await client.request({ type: "open_session", cwd: host.cwd, sessionPath });
		const sessionId = String(dataOf(opened).sessionId);
		const messages = dataOf(await client.request({ type: "get_messages", sessionId })).messages;
		const all = dataOf(await client.request({ type: "get_entries", sessionId })).entries as { type?: string }[];
		const entries = all.filter((entry) => entry.type === "message");
		const attacher = host.client(keyed ? "keyed-attach" : "plain-attach");
		await attacher.request({ type: "open_session", cwd: host.cwd, sessionPath });
		return { history: JSON.stringify({ messages, entries }), attached: attacher.received.join("\n") };
	};
	const plain = await shown(false);
	const keyed = await shown(true);
	expect(plain.history).toContain('"toolCallId":"solo"');
	expect(keyed.history).toBe(plain.history);
	expect(keyed.attached).not.toMatch(/runtimeItemKey|callUnknown/);
}, 600_000);
