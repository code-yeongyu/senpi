import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePermissionFlag } from "../../src/core/extensions/builtin/permission-system/cli.js";
import { disabled, expand, fromConfig, merge } from "../../src/core/extensions/builtin/permission-system/config.js";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.js";
import {
	createLocalEventEmitter,
	type PermissionAskedEvent,
	type PermissionRepliedEvent,
} from "../../src/core/extensions/builtin/permission-system/events.js";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.js";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.js";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.js";
import { loadPermissionSettings } from "../../src/core/extensions/builtin/permission-system/settings.js";
import {
	appendApproved,
	clearApproved,
	loadApproved,
} from "../../src/core/extensions/builtin/permission-system/storage.js";
import {
	CorrectedError,
	DeniedError,
	type PermissionConfig,
	RejectedError,
	type Request,
	type Ruleset,
} from "../../src/core/extensions/builtin/permission-system/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

// Helper to create temp project directory
function createTempProject(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
	mkdirSync(join(tempDir, ".pi"), { recursive: true });
	return tempDir;
}

// Helper to clean up temp directory
function cleanupTempProject(dir: string): void {
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true });
	}
}

// Helper to create a permission service with event tracking
function createTestService(staticRuleset: Ruleset = [], approved: Ruleset = []) {
	const emitter = createLocalEventEmitter();
	const askedEvents: PermissionAskedEvent[] = [];
	const repliedEvents: PermissionRepliedEvent[] = [];

	const unsubscribeAsked = emitter.onAsked((request) => {
		askedEvents.push(request);
	});
	const unsubscribeReplied = emitter.onReplied((event) => {
		repliedEvents.push(event);
	});

	const service = new PermissionService(staticRuleset, approved, emitter);

	return {
		service,
		emitter,
		askedEvents,
		repliedEvents,
		cleanup: () => {
			unsubscribeAsked();
			unsubscribeReplied();
			emitter.clear();
		},
	};
}

// Helper to create a request
function createRequest(overrides: Partial<Request> = {}): Request {
	return {
		id: overrides.id ?? "request-1",
		sessionID: overrides.sessionID ?? "session-1",
		permission: overrides.permission ?? "bash",
		patterns: overrides.patterns ?? ["git commit"],
		always: overrides.always ?? ["git *"],
		metadata: overrides.metadata ?? { command: "git commit -m test" },
		tool: overrides.tool,
	};
}

describe("permission integration", () => {
	describe("1. allow-all config → no prompt, tool executes", () => {
		it("should allow tool execution with wildcard allow rule", async () => {
			// given
			const { service, askedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "allow" },
			]);

			// when
			const result = await service.ask(createRequest({ patterns: ["ls -la"] }));

			// then
			expect(result).toBeUndefined();
			expect(askedEvents).toHaveLength(0);
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should allow specific command with allow-all config", async () => {
			// given
			const { service, askedEvents, cleanup } = createTestService([
				{ permission: "edit", pattern: "*", action: "allow" },
			]);

			// when
			const result = await service.ask(
				createRequest({
					permission: "edit",
					patterns: ["src/index.ts"],
					always: ["src/index.ts"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			expect(askedEvents).toHaveLength(0);
			cleanup();
		});

		it("should allow multiple patterns when all match allow rules", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "allow" }]);

			// when
			const result = await service.ask(
				createRequest({
					patterns: ["echo hello", "ls -la", "pwd"],
					always: ["*"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			cleanup();
		});
	});

	describe("2. deny-all config → tool blocked, DeniedError returned", () => {
		it("should throw DeniedError for denied permission", async () => {
			// given
			const { service, askedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "deny" },
			]);

			// when
			const promise = service.ask(createRequest({ patterns: ["rm -rf /"] }));

			// then
			await expect(promise).rejects.toBeInstanceOf(DeniedError);
			expect(askedEvents).toHaveLength(0);
			cleanup();
		});

		it("should include denied patterns in DeniedError", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "rm *", action: "deny" }]);

			// when
			try {
				await service.ask(createRequest({ patterns: ["rm -rf tmp"] }));
			} catch (err) {
				// then
				expect(err).toBeInstanceOf(DeniedError);
				expect((err as DeniedError).patterns).toEqual(["rm -rf tmp"]);
			}
			cleanup();
		});

		it("should deny when any pattern matches deny rule", async () => {
			// given
			const { service, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "bash", pattern: "rm *", action: "deny" },
			]);

			// when
			const promise = service.ask(
				createRequest({
					patterns: ["echo hello", "rm -rf tmp", "ls"],
				}),
			);

			// then
			await expect(promise).rejects.toBeInstanceOf(DeniedError);
			cleanup();
		});
	});

	describe("3. ask config → pending created, reply('once') → tool executes", () => {
		it("should create pending request with ask config", async () => {
			// given
			const { service, askedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "ask" },
			]);
			const request = createRequest({ id: "req-1" });

			// when
			const askPromise = service.ask(request);

			// then
			expect(service.list()).toHaveLength(1);
			expect(askedEvents).toHaveLength(1);
			expect(askedEvents[0]?.id).toBe("req-1");

			// cleanup
			service.reply({ requestID: "req-1", reply: "once" });
			await askPromise;
			cleanup();
		});

		it("should resolve pending request on once reply", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ id: "req-2" });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-2", reply: "once" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should emit replied event on once reply", async () => {
			// given
			const { service, repliedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "ask" },
			]);
			const request = createRequest({ id: "req-3", sessionID: "sess-1" });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-3", reply: "once" });

			// then
			await askPromise;
			expect(repliedEvents).toEqual([{ requestID: "req-3", sessionID: "sess-1", reply: "once" }]);
			cleanup();
		});
	});

	describe("4. ask config → reply('always') → rule persisted, subsequent calls auto-allowed", () => {
		it("should add always patterns to approved rules", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({
				id: "req-4",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-4", reply: "always" });
			await askPromise;

			// then
			expect(service.getApproved()).toEqual([{ permission: "bash", pattern: "git *", action: "allow" }]);
			cleanup();
		});

		it("should auto-allow subsequent matching requests", async () => {
			// given
			const { service, askedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "ask" },
			]);

			// First request - ask and approve always
			const firstRequest = createRequest({
				id: "req-first",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const firstPromise = service.ask(firstRequest);
			service.reply({ requestID: "req-first", reply: "always" });
			await firstPromise;

			// Reset events
			askedEvents.length = 0;

			// Second request - should auto-allow
			const secondResult = await service.ask(
				createRequest({
					id: "req-second",
					patterns: ["git push"],
					always: ["git *"],
				}),
			);

			// then
			expect(secondResult).toBeUndefined();
			expect(askedEvents).toHaveLength(0);
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should persist multiple always patterns", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({
				id: "req-5",
				patterns: ["git commit"],
				always: ["git *", "gh *"],
			});
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-5", reply: "always" });
			await askPromise;

			// then
			expect(service.getApproved()).toEqual([
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "bash", pattern: "gh *", action: "allow" },
			]);
			cleanup();
		});
	});

	describe("5. ask config → reply('reject') → tool blocked, RejectedError", () => {
		it("should reject pending request with RejectedError", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ id: "req-6" });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-6", reply: "reject" });

			// then
			await expect(askPromise).rejects.toBeInstanceOf(RejectedError);
			cleanup();
		});

		it("should remove request from pending list after reject", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ id: "req-7" });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-7", reply: "reject" });
			await askPromise.catch(() => {});

			// then
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should emit replied event on reject", async () => {
			// given
			const { service, repliedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "ask" },
			]);
			const request = createRequest({ id: "req-8", sessionID: "sess-2" });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: "req-8", reply: "reject" });
			await askPromise.catch(() => {});

			// then
			expect(repliedEvents).toEqual([{ requestID: "req-8", sessionID: "sess-2", reply: "reject" }]);
			cleanup();
		});
	});

	describe("6. ask config → reply('reject', feedback) → CorrectedError with message", () => {
		it("should reject with CorrectedError when feedback provided", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ id: "req-9" });
			const askPromise = service.ask(request);

			// when
			service.reply({
				requestID: "req-9",
				reply: "reject",
				message: "Use git status instead",
			});

			// then
			await expect(askPromise).rejects.toBeInstanceOf(CorrectedError);
			try {
				await askPromise;
			} catch (err) {
				expect((err as CorrectedError).feedback).toBe("Use git status instead");
				expect((err as Error).message).toContain("Use git status instead");
			}
			cleanup();
		});

		it("should include feedback in error message", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ id: "req-10" });
			const askPromise = service.ask(request);

			// when
			service.reply({
				requestID: "req-10",
				reply: "reject",
				message: "This is dangerous, use rm -i instead",
			});

			// then
			const err = await askPromise.catch((e) => e);
			expect(err).toBeInstanceOf(CorrectedError);
			expect(err.message).toContain("This is dangerous");
			cleanup();
		});
	});

	describe("7. cascade reject → multiple pending, one reject cancels all", () => {
		it("should cascade reject to all pending in same session", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request1 = createRequest({
				id: "req-a",
				sessionID: "session-same",
				patterns: ["git commit"],
			});
			const request2 = createRequest({
				id: "req-b",
				sessionID: "session-same",
				patterns: ["git push"],
			});

			const promise1 = service.ask(request1);
			const promise2 = service.ask(request2);

			// when
			service.reply({ requestID: "req-a", reply: "reject" });

			// then
			await expect(promise1).rejects.toBeInstanceOf(RejectedError);
			await expect(promise2).rejects.toBeInstanceOf(RejectedError);
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should emit reject events for cascade cancellations", async () => {
			// given
			const { service, repliedEvents, cleanup } = createTestService([
				{ permission: "bash", pattern: "*", action: "ask" },
			]);
			const request1 = createRequest({
				id: "req-c",
				sessionID: "session-cascade",
				patterns: ["ls"],
			});
			const request2 = createRequest({
				id: "req-d",
				sessionID: "session-cascade",
				patterns: ["pwd"],
			});

			const promise1 = service.ask(request1).catch(() => {});
			const promise2 = service.ask(request2).catch(() => {});

			// when
			service.reply({ requestID: "req-c", reply: "reject" });
			await Promise.all([promise1, promise2]);

			// then
			expect(repliedEvents).toHaveLength(2);
			expect(repliedEvents[0]).toEqual({
				requestID: "req-c",
				sessionID: "session-cascade",
				reply: "reject",
			});
			expect(repliedEvents[1]).toEqual({
				requestID: "req-d",
				sessionID: "session-cascade",
				reply: "reject",
			});
			cleanup();
		});
	});

	describe("8. cascade allow → 'always' auto-resolves matching pending", () => {
		it("should auto-resolve matching pending on always reply", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request1 = createRequest({
				id: "req-e",
				sessionID: "session-auto",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const request2 = createRequest({
				id: "req-f",
				sessionID: "session-auto",
				patterns: ["git push"],
				always: ["git *"],
			});

			const promise1 = service.ask(request1);
			const promise2 = service.ask(request2);

			// when
			service.reply({ requestID: "req-e", reply: "always" });

			// then
			await expect(promise1).resolves.toBeUndefined();
			await expect(promise2).resolves.toBeUndefined();
			expect(service.list()).toHaveLength(0);
			cleanup();
		});

		it("should not auto-resolve non-matching pending", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request1 = createRequest({
				id: "req-g",
				sessionID: "session-partial",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const request2 = createRequest({
				id: "req-h",
				sessionID: "session-partial",
				patterns: ["docker build"],
				always: ["docker *"],
			});

			const promise1 = service.ask(request1);
			const promise2 = service.ask(request2);

			// when
			service.reply({ requestID: "req-g", reply: "always" });

			// then
			await expect(promise1).resolves.toBeUndefined();
			expect(service.list()).toHaveLength(1);
			expect(service.list()[0]?.id).toBe("req-h");

			// cleanup
			service.reply({ requestID: "req-h", reply: "once" });
			await promise2;
			cleanup();
		});

		it("should not auto-resolve pending from different sessions", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request1 = createRequest({
				id: "req-i",
				sessionID: "session-1",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const request2 = createRequest({
				id: "req-j",
				sessionID: "session-2",
				patterns: ["git push"],
				always: ["git *"],
			});

			const promise1 = service.ask(request1);
			const promise2 = service.ask(request2);

			// when
			service.reply({ requestID: "req-i", reply: "always" });

			// then
			await expect(promise1).resolves.toBeUndefined();
			expect(service.list()).toHaveLength(1);
			expect(service.list()[0]?.id).toBe("req-j");

			// cleanup
			service.reply({ requestID: "req-j", reply: "once" });
			await promise2;
			cleanup();
		});
	});

	describe("9. bash arity → 'git commit' allowed by 'git *' rule", () => {
		it("should extract git prefix for git commands", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("bash", { command: "git commit -m test" }, "/project");

			// then
			expect(requests).toHaveLength(1);
			expect(requests[0]?.permission).toBe("bash");
			expect(requests[0]?.patterns).toEqual(["git commit"]);
			expect(requests[0]?.always).toEqual(["git commit", "git commit *"]);
		});

		it("should extract npm prefix for npm commands", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("bash", { command: "npm install lodash" }, "/project");

			// then
			expect(requests[0]?.patterns).toEqual(["npm install"]);
			expect(requests[0]?.always).toEqual(["npm install", "npm install *"]);
		});

		it("should handle simple commands", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("bash", { command: "ls -la" }, "/project");

			// then
			expect(requests[0]?.patterns).toEqual(["ls"]);
			expect(requests[0]?.always).toEqual(["ls", "ls *"]);
		});

		it("should allow git commit with git * rule", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "git *", action: "allow" }]);

			// when
			const result = await service.ask(
				createRequest({
					permission: "bash",
					patterns: ["git commit"],
					always: ["git commit", "git commit *"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			cleanup();
		});
	});

	describe("10. edit unification → write tool uses 'edit' permission key", () => {
		it("should map write tool to edit permission", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("write", { path: "src/index.ts" }, "/project");

			// then
			expect(requests).toHaveLength(1);
			expect(requests[0]?.permission).toBe("edit");
			expect(requests[0]?.patterns).toEqual(["src/index.ts"]);
		});

		it("should map apply_patch to edit permission", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("apply_patch", { file_path: "src/utils.ts" }, "/project");

			// then
			expect(requests[0]?.permission).toBe("edit");
		});

		it("should map multiedit to edit permission", () => {
			// given
			const registry = createBuiltinParserRegistry();

			// when
			const requests = registry.parse("multiedit", { path: "README.md" }, "/project");

			// then
			expect(requests[0]?.permission).toBe("edit");
		});

		it("should allow write via edit allow rule", async () => {
			// given
			const { service, cleanup } = createTestService([{ permission: "edit", pattern: "*", action: "allow" }]);

			// when
			const result = await service.ask(
				createRequest({
					permission: "edit",
					patterns: ["src/index.ts"],
					always: ["src/index.ts"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			cleanup();
		});

		it("should disable all edit tools when edit is denied", () => {
			// given
			const tools = ["edit", "write", "apply_patch", "multiedit", "read"];
			const ruleset: Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result.has("edit")).toBe(true);
			expect(result.has("write")).toBe(true);
			expect(result.has("apply_patch")).toBe(true);
			expect(result.has("multiedit")).toBe(true);
			expect(result.has("read")).toBe(false);
		});
	});

	describe("11. external directory → bash with '../' triggers external_directory permission", () => {
		it("should detect external paths in bash command", () => {
			// given
			const registry = createBuiltinParserRegistry();
			const cwd = "/home/user/project";

			// when
			const requests = registry.parse("bash", { command: "cat ../config.txt" }, cwd);

			// then
			expect(requests).toHaveLength(2);
			expect(requests[0]?.permission).toBe("bash");
			expect(requests[1]?.permission).toBe("external_directory");
			expect(requests[1]?.patterns).toContain("../config.txt");
		});

		it("should detect multiple external paths", () => {
			// given
			const registry = createBuiltinParserRegistry();
			const cwd = "/home/user/project";

			// when
			const requests = registry.parse("bash", { command: "cp ../config.txt ../../backup/" }, cwd);

			// then
			const externalRequest = requests.find((r) => r.permission === "external_directory");
			expect(externalRequest).toBeDefined();
			expect(externalRequest?.patterns).toContain("../config.txt");
			expect(externalRequest?.patterns).toContain("../../backup/");
		});

		it("should not flag internal paths", () => {
			// given
			const registry = createBuiltinParserRegistry();
			const cwd = "/home/user/project";

			// when
			const requests = registry.parse("bash", { command: "cat ./src/index.ts" }, cwd);

			// then
			expect(requests).toHaveLength(1);
			expect(requests[0]?.permission).toBe("bash");
		});

		it("should expand home directory paths", () => {
			// given
			const registry = createBuiltinParserRegistry();
			const cwd = "/home/user/project";

			// when
			const requests = registry.parse("bash", { command: "cat ~/.bashrc" }, cwd);

			// then
			const externalRequest = requests.find((r) => r.permission === "external_directory");
			expect(externalRequest).toBeDefined();
			// The external directory parser returns the raw path, expansion happens in fromConfig
			expect(externalRequest?.patterns[0]).toMatch(/^~\/\.bashrc$/);
		});
	});

	describe("12. disabled() → denied tools removed from active tools", () => {
		it("should return empty set when no deny rules", () => {
			// given
			const tools = ["read", "write", "bash"];
			const ruleset: Ruleset = [
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: "*", action: "ask" },
			];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result.size).toBe(0);
		});

		it("should identify denied tools", () => {
			// given
			const tools = ["read", "bash", "grep"];
			const ruleset: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result.has("bash")).toBe(true);
			expect(result.has("read")).toBe(false);
		});

		it("should handle wildcard permission deny", () => {
			// given
			const tools = ["read", "write", "bash"];
			const ruleset: Ruleset = [{ permission: "*", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result.has("read")).toBe(true);
			expect(result.has("write")).toBe(true);
			expect(result.has("bash")).toBe(true);
		});

		it("should not disable when specific allow after wildcard deny", () => {
			// given
			const tools = ["bash"];
			const ruleset: Ruleset = [
				{ permission: "bash", pattern: "*", action: "deny" },
				{ permission: "bash", pattern: "echo *", action: "allow" },
			];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result.has("bash")).toBe(false);
		});
	});

	describe("13. settings.json config → fromConfig produces correct rules", () => {
		it("should convert flat string values to wildcard rules", () => {
			// given
			const config: PermissionConfig = {
				bash: "allow",
				edit: "ask",
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "edit", pattern: "*", action: "ask" },
			]);
		});

		it("should convert nested config to multiple rules", () => {
			// given
			const config: PermissionConfig = {
				bash: {
					"*": "ask",
					"git *": "allow",
					"rm *": "deny",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "*", action: "ask" },
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "bash", pattern: "rm *", action: "deny" },
			]);
		});

		it("should expand tilde to home directory", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				external_directory: {
					"~/projects/*": "allow",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([{ permission: "external_directory", pattern: `${home}/projects/*`, action: "allow" }]);
		});

		it("should expand $HOME to home directory", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				external_directory: {
					"$HOME/.config/*": "allow",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([{ permission: "external_directory", pattern: `${home}/.config/*`, action: "allow" }]);
		});

		it("should handle mixed flat and nested values", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				read: "allow",
				write: {
					"~/projects/*": "ask",
				},
				bash: {
					"*": "ask",
					"git *": "allow",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: `${home}/projects/*`, action: "ask" },
				{ permission: "bash", pattern: "*", action: "ask" },
				{ permission: "bash", pattern: "git *", action: "allow" },
			]);
		});
	});

	describe("14. CLI flag → overrides settings.json", () => {
		it("should parse simple tool=action format", () => {
			// when
			const result = parsePermissionFlag("bash=allow");

			// then
			expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }]);
		});

		it("should parse tool:pattern=action format", () => {
			// when
			const result = parsePermissionFlag("bash:git *=allow");

			// then
			expect(result).toEqual([{ permission: "bash", pattern: "git *", action: "allow" }]);
		});

		it("should parse multiple rules separated by comma", () => {
			// when
			const result = parsePermissionFlag("bash=allow,edit=ask,read=deny");

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "edit", pattern: "*", action: "ask" },
				{ permission: "read", pattern: "*", action: "deny" },
			]);
		});

		it("should trim whitespace around components", () => {
			// when
			const result = parsePermissionFlag(" bash = allow , edit = ask ");

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "edit", pattern: "*", action: "ask" },
			]);
		});

		it("should give CLI precedence over static rules", async () => {
			// given
			const cliRules: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
			const staticRules: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];

			// Create service with CLI rules as approved (highest precedence)
			const { service, cleanup } = createTestService(staticRules, cliRules);

			// when - CLI allow should win over static deny
			const result = await service.ask(
				createRequest({
					permission: "bash",
					patterns: ["ls"],
					always: ["*"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			cleanup();
		});
	});

	describe("15. JSONL persistence → approved rules survive service reconstruction", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = createTempProject();
		});

		afterEach(() => {
			cleanupTempProject(tempDir);
		});

		it("should persist approved rules to JSONL file", () => {
			// given
			const rules: Ruleset = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "edit", pattern: "src/*", action: "allow" },
			];

			// when
			appendApproved(tempDir, rules);

			// then
			const loaded = loadApproved(tempDir);
			expect(loaded).toEqual(rules);
		});

		it("should load approved rules after service reconstruction", async () => {
			// given - first service instance
			const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({
				id: "req-persist",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const askPromise = service.ask(request);
			service.reply({ requestID: "req-persist", reply: "always" });
			await askPromise;

			// Get approved rules and persist them
			const approved = service.getApproved();
			appendApproved(tempDir, approved);
			cleanup();

			// when - create new service with loaded approved rules
			const loadedApproved = loadApproved(tempDir);
			const {
				service: service2,
				askedEvents,
				cleanup: cleanup2,
			} = createTestService([{ permission: "bash", pattern: "*", action: "ask" }], loadedApproved);

			// Second request should auto-allow
			const result = await service2.ask(
				createRequest({
					id: "req-second",
					patterns: ["git push"],
					always: ["git *"],
				}),
			);

			// then
			expect(result).toBeUndefined();
			expect(askedEvents).toHaveLength(0);
			cleanup2();
		});

		it("should append multiple rules to JSONL file", () => {
			// given
			const rules1: Ruleset = [{ permission: "bash", pattern: "git *", action: "allow" }];
			const rules2: Ruleset = [{ permission: "edit", pattern: "src/*", action: "allow" }];

			// when
			appendApproved(tempDir, rules1);
			appendApproved(tempDir, rules2);

			// then
			const loaded = loadApproved(tempDir);
			expect(loaded).toEqual([...rules1, ...rules2]);
		});

		it("should return empty array when no persistence file exists", () => {
			// when
			const result = loadApproved(tempDir);

			// then
			expect(result).toEqual([]);
		});

		it("should clear approved rules", () => {
			// given
			const rules: Ruleset = [{ permission: "bash", pattern: "git *", action: "allow" }];
			appendApproved(tempDir, rules);

			// when
			clearApproved(tempDir);

			// then
			const loaded = loadApproved(tempDir);
			expect(loaded).toEqual([]);
		});

		it("should load approved rules from cwd even when project settings define sessionDir", () => {
			// given
			const sessionDir = createTempProject();
			const approvedRules: Ruleset = [{ permission: "bash", pattern: "git *", action: "allow" }];
			appendApproved(tempDir, approvedRules);
			writeFileSync(join(tempDir, ".pi", "settings.json"), JSON.stringify({ sessionDir }, null, 2));
			const settingsManager = SettingsManager.create(tempDir);

			// when
			const loaded = loadPermissionSettings(settingsManager, [], tempDir);

			// then
			expect(loaded.approved).toEqual(approvedRules);
			cleanupTempProject(sessionDir);
		});
	});

	describe("additional integration scenarios", () => {
		describe("evaluate function", () => {
			it("should return ask for unknown permission", () => {
				// when
				const result = evaluate("unknown_tool", "anything", [
					{ permission: "bash", pattern: "*", action: "allow" },
				]);

				// then
				expect(result.action).toBe("ask");
			});

			it("should return last matching rule", () => {
				// given
				const ruleset: Ruleset = [
					{ permission: "bash", pattern: "*", action: "allow" },
					{ permission: "bash", pattern: "rm", action: "deny" },
				];

				// when
				const result = evaluate("bash", "rm", ruleset);

				// then
				expect(result.action).toBe("deny");
			});

			it("should support glob patterns", () => {
				// given
				const ruleset: Ruleset = [{ permission: "edit", pattern: "src/*", action: "allow" }];

				// when
				const result = evaluate("edit", "src/components/Button.tsx", ruleset);

				// then
				expect(result.action).toBe("allow");
			});

			it("should merge multiple rulesets", () => {
				// given
				const config: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
				const approved: Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }];

				// when
				const result = evaluate("bash", "rm", config, approved);

				// then
				expect(result.action).toBe("deny");
			});
		});

		describe("merge function", () => {
			it("should concatenate multiple rulesets", () => {
				// given
				const ruleset1: Ruleset = [{ permission: "read", pattern: "*", action: "allow" }];
				const ruleset2: Ruleset = [{ permission: "write", pattern: "*", action: "ask" }];
				const ruleset3: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];

				// when
				const result = merge(ruleset1, ruleset2, ruleset3);

				// then
				expect(result).toEqual([
					{ permission: "read", pattern: "*", action: "allow" },
					{ permission: "write", pattern: "*", action: "ask" },
					{ permission: "bash", pattern: "*", action: "deny" },
				]);
			});

			it("should preserve rule order", () => {
				// given
				const ruleset1: Ruleset = [
					{ permission: "edit", pattern: "src/*", action: "allow" },
					{ permission: "edit", pattern: "src/secret/*", action: "deny" },
				];
				const ruleset2: Ruleset = [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }];

				// when
				const result = merge(ruleset1, ruleset2);

				// then
				expect(result).toEqual([
					{ permission: "edit", pattern: "src/*", action: "allow" },
					{ permission: "edit", pattern: "src/secret/*", action: "deny" },
					{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
				]);
			});
		});

		describe("expand function", () => {
			it("should expand ~ to home directory", () => {
				// given
				const home = os.homedir();

				// when
				const result = expand("~");

				// then
				expect(result).toBe(home);
			});

			it("should expand ~/path to home directory", () => {
				// given
				const home = os.homedir();

				// when
				const result = expand("~/projects/foo");

				// then
				expect(result).toBe(`${home}/projects/foo`);
			});

			it("should expand $HOME to home directory", () => {
				// given
				const home = os.homedir();

				// when
				const result = expand("$HOME");

				// then
				expect(result).toBe(home);
			});

			it("should not expand tilde in middle of path", () => {
				// given
				const path = "/some/~/path";

				// when
				const result = expand(path);

				// then
				expect(result).toBe(path);
			});
		});

		describe("parser registry", () => {
			it("should fallback to wildcard for unknown tools", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("unknown_tool", {}, "/project");

				// then
				expect(requests).toHaveLength(1);
				expect(requests[0]?.permission).toBe("unknown_tool");
				expect(requests[0]?.patterns).toEqual(["*"]);
			});

			it("should parse read tool with path", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("read", { path: "src/index.ts" }, "/project");

				// then
				expect(requests[0]?.permission).toBe("read");
				expect(requests[0]?.patterns).toEqual(["src/index.ts"]);
			});

			it("should parse read tool with file_path", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("read", { file_path: "README.md" }, "/project");

				// then
				expect(requests[0]?.patterns).toEqual(["README.md"]);
			});

			it("should parse grep tool", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("grep", { pattern: "foo", path: "src" }, "/project");

				// then
				expect(requests[0]?.permission).toBe("grep");
				expect(requests[0]?.patterns).toEqual(["src"]);
			});

			it("should parse find tool", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("find", { path: "src" }, "/project");

				// then
				expect(requests[0]?.permission).toBe("list");
				expect(requests[0]?.patterns).toEqual(["src"]);
			});

			it("should parse ls tool", () => {
				// given
				const registry = createBuiltinParserRegistry();

				// when
				const requests = registry.parse("ls", {}, "/project");

				// then
				expect(requests[0]?.permission).toBe("list");
				expect(requests[0]?.patterns).toEqual(["."]);
			});
		});

		describe("non-interactive handler", () => {
			it("should allow when CLI override allows", () => {
				// given
				const request = createRequest({ id: "req-noui", patterns: ["ls"] });
				const cliOverride: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
				const staticRuleset: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
				const events: Array<{ event: string; data: unknown }> = [];

				// when
				const result = handleNoUI(request, staticRuleset, cliOverride, (event, data) =>
					events.push({ event, data }),
				);

				// then
				expect(result).toBeUndefined();
				expect(events).toHaveLength(2);
				expect(events[0]?.event).toBe("permission_asked");
				expect(events[1]?.event).toBe("permission_replied");
				expect((events[1]?.data as { reply: string }).reply).toBe("allow");
			});

			it("should reject when CLI override denies", () => {
				// given
				const request = createRequest({ id: "req-noui-2", patterns: ["ls"] });
				const cliOverride: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
				const staticRuleset: Ruleset = [];
				const events: Array<{ event: string; data: unknown }> = [];

				// when
				const result = handleNoUI(request, staticRuleset, cliOverride, (event, data) =>
					events.push({ event, data }),
				);

				// then
				expect(result).toEqual({
					requestID: "req-noui-2",
					reply: "reject",
					message: "Permission denied by CLI flag: bash",
				});
			});

			it("should auto-reject when no rules match in no-UI mode", () => {
				// given
				const request = createRequest({ id: "req-noui-3", patterns: ["ls", "pwd"] });
				const cliOverride: Ruleset = [];
				const staticRuleset: Ruleset = [];
				const events: Array<{ event: string; data: unknown }> = [];

				// when
				const result = handleNoUI(request, staticRuleset, cliOverride, (event, data) =>
					events.push({ event, data }),
				);

				// then
				expect(result).toEqual({
					requestID: "req-noui-3",
					reply: "reject",
					message: "Permission required for bash (ls, pwd). Use --permission bash=allow to override.",
				});
			});
		});

		describe("complex scenarios", () => {
			it("should handle multiple sessions independently", async () => {
				// given
				const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);

				const request1 = createRequest({
					id: "req-sess-1",
					sessionID: "session-1",
					patterns: ["ls"],
				});
				const request2 = createRequest({
					id: "req-sess-2",
					sessionID: "session-2",
					patterns: ["pwd"],
				});

				const promise1 = service.ask(request1);
				const promise2 = service.ask(request2);

				// when - reject only session 1
				service.reply({ requestID: "req-sess-1", reply: "reject" });

				// then
				await expect(promise1).rejects.toBeInstanceOf(RejectedError);
				expect(service.list()).toHaveLength(1);
				expect(service.list()[0]?.sessionID).toBe("session-2");

				// cleanup
				service.reply({ requestID: "req-sess-2", reply: "once" });
				await promise2;
				cleanup();
			});

			it("should handle request without explicit id", async () => {
				// given
				const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);

				// when
				const askPromise = service.ask({
					sessionID: "session-1",
					permission: "bash",
					patterns: ["ls"],
					always: ["*"],
					metadata: {},
				});

				const pending = service.list();

				// then
				expect(pending).toHaveLength(1);
				expect(pending[0]?.id).toBe("permission-1");

				// cleanup
				service.reply({ requestID: "permission-1", reply: "once" });
				await askPromise;
				cleanup();
			});

			it("should increment ids for multiple requests without explicit ids", async () => {
				// given
				const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);

				// when
				const promise1 = service.ask({
					sessionID: "session-1",
					permission: "bash",
					patterns: ["ls"],
					always: ["*"],
					metadata: {},
				});
				const id1 = service.list()[0]?.id;
				service.reply({ requestID: id1 ?? "", reply: "once" });
				await promise1;

				const promise2 = service.ask({
					sessionID: "session-1",
					permission: "bash",
					patterns: ["pwd"],
					always: ["*"],
					metadata: {},
				});
				const id2 = service.list()[0]?.id;

				// then
				expect(id1).toBe("permission-1");
				expect(id2).toBe("permission-2");

				// cleanup
				service.reply({ requestID: id2 ?? "", reply: "once" });
				await promise2;
				cleanup();
			});

			it("should ignore replies for unknown request ids", () => {
				// given
				const { service, repliedEvents, cleanup } = createTestService([
					{ permission: "bash", pattern: "*", action: "allow" },
				]);

				// when
				service.reply({ requestID: "unknown-id", reply: "once" });

				// then
				expect(service.list()).toHaveLength(0);
				expect(repliedEvents).toHaveLength(0);
				cleanup();
			});

			it("should return defensive copy from list()", async () => {
				// given
				const { service, cleanup } = createTestService([{ permission: "bash", pattern: "*", action: "ask" }]);
				const request = createRequest({ id: "req-copy" });
				const askPromise = service.ask(request);

				// when
				const list1 = service.list();
				list1[0]?.patterns.push("modified");
				const list2 = service.list();

				// then
				expect(list2[0]?.patterns).not.toContain("modified");

				// cleanup
				service.reply({ requestID: "req-copy", reply: "once" });
				await askPromise;
				cleanup();
			});
		});
	});
});
