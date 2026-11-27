import { join } from "node:path";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

function wire(command: Record<string, unknown>): RpcCommand {
	return JSON.parse(JSON.stringify(command)) as RpcCommand;
}

// senpi#7567: a session opened with no tools exposes none to its model, and no RPC command runs a process for it.
it("refuses bash with tools_disabled for a session opened with no tools, and runs nothing", async () => {
	// given
	await using host = await contextHost();
	const opened = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persona: { tools: [] } })),
	);
	const sessionId = String(opened.sessionId);
	const marker = join(host.scratch, "ran");

	// when
	const bash = await host.send("conn-a", { type: "bash", sessionId, command: `touch ${marker}` });

	// then
	expect(bash).toMatchObject({ success: false, errorCode: "tools_disabled" });
	expect(String(bash?.error)).toMatch(/^tools_disabled: /);
	expect(existsSync(marker)).toBe(false);
});

it("gives a session opened with no tools an empty active tool set, while a plain session keeps bash", async () => {
	await using host = await contextHost();
	const none = responseData(
		await host.send("conn-a", wire({ type: "open_session", cwd: host.cwd, persona: { tools: [] } })),
	);
	const plain = await host.open("conn-b", {});

	const bash = await host.send("conn-b", { type: "bash", sessionId: String(plain.sessionId), command: "echo hi" });

	expect(host.activeTools(String(none.sessionId))).toEqual([]);
	expect(responseData(bash).output).toContain("hi");
});

it("advertises session_tools_none_enforced in get_protocol_info", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(info.capabilities).toContain("session_tools_none_enforced");
});
