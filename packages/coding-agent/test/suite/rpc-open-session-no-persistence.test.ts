import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

/** Every file and directory under `root` with each file's content digest: what a session could have left on disk. */
async function tree(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const listed = await Promise.all(
		entries.map(async (entry) => {
			const path = join(entry.parentPath, entry.name);
			// The host's diagnostic log is content-free (allowlisted keys, no message text) and is written for every
			// session, as the CLI's own --no-session writes it: its presence is compared, its growth is not.
			if (!entry.isFile() || relative(root, path) === join("agent", "logs", "session.log"))
				return relative(root, path);
			return `${relative(root, path)} ${createHash("sha256")
				.update(await readFile(path))
				.digest("hex")}`;
		}),
	);
	return listed.sort();
}

/** The wire carries JSON: `persistence` is sent as a client would, typed or not. */
function wire(command: Record<string, unknown>): RpcCommand {
	return JSON.parse(JSON.stringify(command)) as RpcCommand;
}

function fauxThatAnswers() {
	const faux = fauxProvider({ api: "faux-ephemeral", provider: "faux-ephemeral" });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("answered")));
	return faux;
}

function sessionRows(record: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	const sessions = responseData(record).sessions;
	if (!Array.isArray(sessions)) throw new Error("list_sessions answered no rows");
	return sessions;
}

/**
 * Open, prompt, bash and close one memory-only session and return the host's answers. The first runtime of a host
 * creates host-wide state (its credential and model stores, the kill guard, the host log), so a test compares what a
 * SECOND session leaves against the first's (senpi#7567).
 */
async function ephemeralLifecycle(host: Awaited<ReturnType<typeof contextHost>>) {
	const opened = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none" })),
	);
	const sessionId = String(opened.sessionId);
	await host.prompt("conn-a", sessionId, "hello");
	const bash = await host.send("conn-a", { type: "bash", sessionId, command: "echo hi", excludeFromContext: true });
	const state = responseData(await host.send("conn-a", { type: "get_state", sessionId }));
	const row = sessionRows(await host.send("conn-a", { type: "list_sessions" })).find(
		(listed) => listed.sessionId === sessionId,
	);
	const closed = await host.send("conn-a", { type: "close_session", sessionId });
	return { opened, bash, state, row, closed };
}

it("writes nothing anywhere for a session opened with persistence none: not at open, prompt, bash or close", async () => {
	// given
	await using host = await contextHost({ faux: fauxThatAnswers() });
	await ephemeralLifecycle(host);
	const before = await tree(host.scratch);

	// when
	const { opened, bash, state, row, closed } = await ephemeralLifecycle(host);

	// then
	expect(responseData(bash).output).toContain("hi");
	expect(state.sessionFile ?? null).toBeNull();
	expect(opened.sessionPath ?? null).toBeNull();
	expect(row?.persistence).toBe("none");
	expect(closed?.success).toBe(true);
	expect(await tree(host.scratch)).toEqual(before);
	expect(before.filter((path) => path.startsWith("agent/sessions") || path.includes(".jsonl"))).toEqual([]);
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("refuses a persistence value it does not know as an invalid launch profile and opens nothing", async () => {
	await using host = await contextHost();

	const bogus = await host.openFailure("conn-a", { persistence: "disk" });
	const notString = await host.openFailure("conn-a", { persistence: false });

	expect(bogus).toMatch(/^invalid_launch_profile: .*persistence/);
	expect(notString).toMatch(/^invalid_launch_profile: .*persistence/);
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("refuses persistence none together with a sessionPath or retain_on_disconnect", async () => {
	await using host = await contextHost();
	const before = await tree(host.scratch);

	const withPath = await host.openFailure("conn-a", {
		persistence: "none",
		sessionPath: join(host.scratch, "named.jsonl"),
	});
	const retained = await host.openFailure("conn-a", { persistence: "none", retain_on_disconnect: true });

	expect(withPath).toMatch(/^invalid_launch_profile: .*sessionPath/);
	expect(retained).toMatch(/^invalid_launch_profile: .*retain_on_disconnect/);
	expect(await tree(host.scratch)).toEqual(before);
}, 120_000);

it("advertises session_persistence_none in get_protocol_info", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(info.capabilities).toContain("session_persistence_none");
}, 120_000);

it("marks a memory-only session's list_sessions row persistence none, and only that one", async () => {
	await using host = await contextHost();
	const ephemeral = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none" })),
	);
	const persisted = await host.open("conn-a", {});

	const rows = sessionRows(await host.send("conn-a", { type: "list_sessions" }));

	expect(rows.find((row) => row.sessionId === ephemeral.sessionId)?.persistence).toBe("none");
	expect(rows.find((row) => row.sessionId === persisted.sessionId)).not.toHaveProperty("persistence");
}, 120_000);

it("tells the controller why a memory-only session ended: not_persisted at a handoff, distinct from a close and a stop", async () => {
	// given
	await using draining = await contextHost();
	await using stopping = await contextHost();
	const open = async (host: typeof draining) =>
		String(
			responseData(await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none" })))
				.sessionId,
		);
	const handedOver = await open(draining);
	const closedByClient = await open(draining);
	const stopped = await open(stopping);
	const closedRecord = (host: typeof draining, sessionId: string) =>
		host.waitFor((record) => record.type === "session_closed" && record.sessionId === sessionId);
	const clientClose = closedRecord(draining, closedByClient);
	const handoff = closedRecord(draining, handedOver);
	const stop = closedRecord(stopping, stopped);

	// when
	await draining.send("conn-a", { type: "close_session", sessionId: closedByClient });
	draining.router.beginDrain();
	await stopping.router.dispose();

	// then
	expect((await clientClose).reason).toBe("client_close");
	expect(await handoff).toEqual({ type: "session_closed", sessionId: handedOver, reason: "not_persisted" });
	expect((await stop).reason).toBe("host_shutdown");
}, 120_000);

it("keeps a durableSessionId of a memory-only session out of find_session and out of any file", async () => {
	// given
	await using host = await contextHost();
	const durableSessionId = "0195f0c6-8d0e-7000-8000-00000000abcd";
	const opened = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none", durableSessionId })),
	);
	const before = await tree(host.scratch);

	// when
	const found = responseData(await host.send("conn-a", { type: "find_session", durableSessionId }));
	const reopened = await host.send("conn-b", { type: "open_session", cwd: host.cwd, durableSessionId });

	// then
	expect((opened.state as { sessionId?: unknown }).sessionId).toBe(durableSessionId);
	expect(found).toEqual({ unknown: true });
	expect(reopened?.success).toBe(false);
	expect(String(reopened?.error)).toContain("session_id_in_use");
	expect(await tree(host.scratch)).toEqual(before);
}, 120_000);

it("keeps a replaced session in memory: new_session stays unpersisted and switch_session to a file is refused", async () => {
	// given
	await using host = await contextHost({ faux: fauxThatAnswers() });
	const persisted = await host.open("conn-b", {});
	await host.prompt("conn-b", String(persisted.sessionId), "make a file");
	const target = String(
		responseData(await host.send("conn-b", { type: "get_state", sessionId: String(persisted.sessionId) }))
			.sessionFile,
	);
	const opened = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none" })),
	);
	const sessionId = String(opened.sessionId);
	const before = await tree(host.scratch);

	// when
	const replaced = await host.send("conn-a", { type: "new_session", sessionId });
	await host.prompt("conn-a", sessionId, "hello");
	const switched = await host.send("conn-a", { type: "switch_session", sessionId, sessionPath: target });
	const state = responseData(await host.send("conn-a", { type: "get_state", sessionId }));

	// then
	expect(replaced?.success).toBe(true);
	expect(switched?.success).toBe(false);
	expect(String(switched?.error)).toContain("session_not_persisted");
	expect(state.sessionFile ?? null).toBeNull();
	expect(await tree(host.scratch)).toEqual(before);
}, 120_000);
