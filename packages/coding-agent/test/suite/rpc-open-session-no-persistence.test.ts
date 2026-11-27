import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

/** Every file and directory under `root`, relative to it: what a session could have left on disk. */
async function tree(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries.map((entry) => relative(root, join(entry.parentPath, entry.name))).sort();
}

/** The wire carries JSON: `persistence` is sent as a client would, typed or not. */
function wire(command: Record<string, unknown>): RpcCommand {
	return JSON.parse(JSON.stringify(command)) as RpcCommand;
}

function fauxThatAnswers() {
	const faux = fauxProvider({ api: "faux-ephemeral", provider: "faux-ephemeral" });
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("answered")));
	return faux;
}

it("writes nothing anywhere for a session opened with persistence none: not at open, prompt, bash or close", async () => {
	// given
	await using host = await contextHost({ faux: fauxThatAnswers() });
	const before = await tree(host.scratch);
	const opened = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persistence: "none" })),
	);
	const sessionId = String(opened.sessionId);

	// when
	await host.prompt("conn-a", sessionId, "hello");
	const bash = await host.send("conn-a", { type: "bash", sessionId, command: "echo hi", excludeFromContext: true });
	const state = responseData(await host.send("conn-a", { type: "get_state", sessionId }));
	const closed = await host.send("conn-a", { type: "close_session", sessionId });

	// then
	expect(responseData(bash).output).toContain("hi");
	expect(state.sessionFile ?? null).toBeNull();
	expect(opened.sessionPath ?? null).toBeNull();
	expect(closed?.success).toBe(true);
	expect(await tree(host.scratch)).toEqual(before);
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

it("keeps a replaced session in memory: new_session stays unpersisted and switch_session to a file is refused", async () => {
	// given
	await using host = await contextHost({ faux: fauxThatAnswers() });
	const persisted = await host.open("conn-b", {});
	await host.prompt("conn-b", String(persisted.sessionId), "make a file");
	const target = String(responseData(await host.send("conn-b", { type: "get_state", sessionId: String(persisted.sessionId) })).sessionFile);
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
