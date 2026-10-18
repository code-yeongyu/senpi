/**
 * MEDIUM 3 + 4 (Opus #3301 review): the shutdown append must track rules by identity, and a failed
 * persist must not abort the tool call.
 *
 * MEDIUM 3: `getApproved().slice(initialApprovedCount)` broke once approvals refresh — another
 * session appending re-appends its rules as duplicates at shutdown, and deleting the file drops this
 * session's unsaved answers (or resurrects a revoked one). The service exposes the session-owned
 * suffix by identity (permission+pattern+action), never by index.
 *
 * MEDIUM 4: a failed `appendApproved` after the ask resolved used to escape and abort the tool call;
 * it is caught, logged, and left unmarked so the shutdown append retries it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { appendApproved, approvedStorePath } from "../../src/core/extensions/builtin/permission-system/storage.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";

function alwaysRequest(id: string, permission: string, always: string[]): Request {
	return {
		id,
		sessionID: "session-1",
		permission,
		patterns: always,
		always,
		metadata: {},
	};
}

describe("MEDIUM 3: the shutdown append tracks this session's answers by identity", () => {
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-m3-agent-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-m3-project-"));
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it("another session appending does not make this session re-append duplicates", async () => {
		// given a service that answered Always for echo, then a SECOND session persisted ls to the store
		const service = new PermissionService(
			[{ permission: "*", pattern: "*", action: "ask" }],
			[],
			createLocalEventEmitter(),
			"ask",
			projectDir,
			agentDir,
		);
		const request = alwaysRequest("r1", "bash", ["echo *"]);
		const pending = service.ask(request);
		service.reply({ requestID: "r1", reply: "always" });
		await pending;
		appendApproved(agentDir, projectDir, [{ permission: "bash", pattern: "ls *", action: "allow" }]);

		// when a decision refreshes the store (pulling the other session's ls in)
		service.dispatchDecision("bash", "ls -la");

		// then this session's own suffix is still exactly its echo answer, not the other session's ls
		expect(service.getSessionApproved()).toEqual([{ permission: "bash", pattern: "echo *", action: "allow" }]);
	});

	it("deleting the store does not drop this session's unsaved answers", async () => {
		// given a service that answered Always for echo (persisted) and gh (still in memory only)
		const service = new PermissionService(
			[{ permission: "*", pattern: "*", action: "ask" }],
			[],
			createLocalEventEmitter(),
			"ask",
			projectDir,
			agentDir,
		);
		const first = service.ask(alwaysRequest("r1", "bash", ["echo *"]));
		service.reply({ requestID: "r1", reply: "always" });
		await first;
		appendApproved(agentDir, projectDir, [{ permission: "bash", pattern: "echo *", action: "allow" }]);
		const second = service.ask(alwaysRequest("r2", "bash", ["gh *"]));
		service.reply({ requestID: "r2", reply: "always" });
		await second;

		// when the store is deleted (a revocation) and a refresh runs
		fs.rmSync(approvedStorePath(agentDir, projectDir), { force: true });
		service.dispatchDecision("bash", "echo x");

		// then this session's own answers are intact — nothing unsaved was lost or resurrected
		expect(service.getSessionApproved()).toEqual([
			{ permission: "bash", pattern: "echo *", action: "allow" },
			{ permission: "bash", pattern: "gh *", action: "allow" },
		]);
	});
});
