import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapError, resolveSessionRow, runHostSessionRequest } from "../src/modes/rpc/host-session-runner.ts";
import { RpcCommandError, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hs-unit-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// #3073: callers distinguish refusal, caller error and broken transport without scraping prose.
describe("host session runner", () => {
	it("refuses an unavailable host without starting one", async () => {
		const agentDir = scratch();
		expect(
			await runHostSessionRequest({ action: "list", target: { agentDir, socket: join(agentDir, "absent.sock") } }),
		).toMatchObject({ exitCode: 3, payload: { action: "refuse", reason: "host_unavailable" } });
	});

	it("rejects a terminal endpoint before connecting", async () => {
		const agentDir = scratch();
		expect(
			await runHostSessionRequest({
				action: "list",
				target: { agentDir, socket: join(agentDir, "t-0123456789abcdef.sock") },
			}),
		).toMatchObject({ exitCode: 3, payload: { reason: "unsupported_endpoint_kind" } });
	});

	it.each([
		["unknown_session", "unknown_session", 3],
		["future_code", "future_code", 3],
		["invalid_path", "invalid_path", 2],
		["open_failed", "open_failed", 1],
		["Model not found: a/b", undefined, 3],
		["Entry not found: x", undefined, 3],
		["Agent is already processing a prompt", undefined, 3],
	] as const)("maps host response %s", (message, code, exitCode) => {
		const reason =
			code ??
			(message.startsWith("Model") ? "model_not_found" : message.startsWith("Entry") ? "unknown_cursor" : "busy");
		const data = { holders: [{ pid: 42 }] };
		expect(mapError(new RpcCommandError(message, code, data), "/rpc.sock")).toEqual({
			exitCode,
			payload: { action: exitCode === 3 ? "refuse" : "error", reason, detail: message, data, socket: "/rpc.sock" },
		});
	});

	it("classifies lost transport separately from host refusals", () => {
		expect(mapError(new RpcTransportGoneError(), "/rpc.sock")).toMatchObject({
			exitCode: 1,
			payload: { action: "error", reason: "transport_gone" },
		});
	});

	it("resolves routing ids before durable ids, names and canonical paths", async () => {
		const dir = scratch();
		const path = join(dir, "session.jsonl");
		writeFileSync(path, "");
		const alias = join(dir, "alias.jsonl");
		symlinkSync(path, alias);
		const row = {
			sessionId: "rpc-1",
			durableSessionId: "durable",
			name: "lane",
			sessionPath: path,
			cwd: dir,
			status: "open" as const,
		};
		const client = { listSessions: async () => [row] };
		for (const ref of ["rpc-1", "durable", "lane", path, alias])
			expect(await resolveSessionRow(client, ref)).toBe(row);
		expect(await resolveSessionRow(client, "missing")).toBeUndefined();
	});
});
