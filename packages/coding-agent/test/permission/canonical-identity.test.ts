import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { isExternalPath } from "../../src/core/extensions/builtin/permission-system/external-dir.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { showPermissionPrompt } from "../../src/core/extensions/builtin/permission-system/prompt.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { appendApproved, loadApproved } from "../../src/core/extensions/builtin/permission-system/storage.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

// #4311: classification, rule evaluation, remembered scope and display must identify the same target.
describe("canonical external-directory identity", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	let alias: string;
	const registry = createBuiltinParserRegistry();

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-identity-")));
		cwd = join(root, "Project");
		outside = join(root, "outside");
		alias = join(root, "alias");
		mkdirSync(cwd);
		mkdirSync(outside);
		symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
		writeFileSync(join(outside, "file.txt"), "fixture");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(["write", "edit", "multiedit", "apply_patch", "read", "grep", "ls", "find", "glob", "monitor", "bash"])(
		"%s cannot use an alias approval to bypass a real-target deny",
		(tool) => {
			const target = join(outside, "file.txt");
			const aliased = join(alias, "file.txt");
			const input = tool === "bash" ? { command: `cat "${aliased}"` } : { path: aliased };
			const external = registry
				.parse(tool, input, cwd)
				.find((request) => request.permission === "external_directory");
			expect(external).toBeDefined();
			const service = new PermissionService(
				[
					...rulesForPreset("accept-edits"),
					{ permission: "external_directory", pattern: `${outside}/*`, action: "deny" },
				],
				[{ permission: "external_directory", pattern: `${alias}/*`, action: "allow" }],
			);
			expect(service.dispatchDecision("external_directory", external?.patterns ?? []).action).toBe("deny");
			expect(external?.patterns).toEqual([target]);
		},
	);

	it("remembers the resolved parent of a missing target and reuses it across aliases", async () => {
		const aliased = join(alias, "missing", "nested", "file.txt");
		const target = join(outside, "missing", "nested", "file.txt");
		const external = registry
			.parse("write", { path: aliased }, cwd)
			.find((r) => r.permission === "external_directory");
		expect(external).toBeDefined();
		if (!external) throw new Error("Missing external-directory request");
		expect(external.patterns).toEqual([target]);
		expect(external.always).toEqual([`${join(outside, "missing", "nested")}/*`]);
		const emitter = createLocalEventEmitter();
		const service = new PermissionService(rulesForPreset("accept-edits"), [], emitter);
		emitter.onAsked((request) => service.reply({ requestID: request.id, reply: "always" }));
		await service.ask({ ...external, sessionID: "identity", metadata: {} });
		const agentDir = join(root, "agent");
		appendApproved(agentDir, cwd, service.getSessionApproved());
		const reloaded = new PermissionService(rulesForPreset("accept-edits"), loadApproved(agentDir, cwd));
		expect(reloaded.dispatchDecision("external_directory", target).action).toBe("allow");
		// The approval names the original target, not wherever the alias points next.
		rmSync(alias);
		const other = join(root, "other");
		mkdirSync(other);
		symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
		const changed = registry
			.parse("write", { path: aliased }, cwd)
			.find((r) => r.permission === "external_directory");
		expect(reloaded.dispatchDecision("external_directory", changed?.patterns ?? []).action).toBe("ask");
	});

	it.each([1, 2])("displays all %s resolved literal targets alongside their lexical spellings", async (count) => {
		const aliased = join(alias, "legal*name.txt");
		const target = join(outside, "legal*name.txt");
		const aliases = [aliased, join(alias, "second.txt")].slice(0, count);
		const targets = [target, join(outside, "second.txt")].slice(0, count);
		const external = registry
			.parse("bash", { command: `cat ${aliases.map((path) => `"${path}"`).join(" ")}` }, cwd)
			.find((r) => r.permission === "external_directory");
		expect(external).toBeDefined();
		if (!external) throw new Error("Missing external-directory request");
		const request: Request = {
			...external,
			id: "identity",
			sessionID: "identity",
			metadata: { parentDir: cwd, filepath: aliased },
		};
		const select = vi.fn().mockResolvedValue("Allow once");
		await showPermissionPrompt({ ui: { select } } as unknown as ExtensionContext, request);
		const message = String(select.mock.calls[0]?.[0]);
		expect(
			message
				.split("\n")
				.filter((line) => line.startsWith("Directory: "))
				.map((line) => line.slice("Directory: ".length)),
		).toEqual(targets);
		for (const path of aliases) expect(message).toContain(path);
	});

	it("keeps existing and missing case aliases inside the same directory", (context) => {
		const caseAlias = join(root, "project");
		let aliasInfo: Stats;
		try {
			aliasInfo = statSync(caseAlias);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			context.skip();
			return;
		}
		const actualInfo = statSync(cwd);
		if (aliasInfo.dev !== actualInfo.dev || aliasInfo.ino !== actualInfo.ino) {
			context.skip();
			return;
		}
		writeFileSync(join(cwd, "file.txt"), "fixture");
		expect(isExternalPath(join(caseAlias, "file.txt"), cwd)).toBe(false);
		expect(isExternalPath(join(caseAlias, "missing", "nested", "file.txt"), cwd)).toBe(false);
		expect(isExternalPath(join(cwd, "missing", "file.txt"), caseAlias)).toBe(false);
		expect(registry.parse("write", { path: join(caseAlias, "file.txt") }, cwd).map((r) => r.permission)).toEqual([
			"edit",
		]);
		expect(isExternalPath(join(outside, "file.txt"), caseAlias)).toBe(true);
	});

	it("keeps distinct case-sensitive directories separate", (context) => {
		const other = join(root, "project");
		try {
			mkdirSync(other);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			context.skip();
			return;
		}
		expect(isExternalPath(join(other, "missing", "file.txt"), cwd)).toBe(true);
		expect(isExternalPath(join(cwd, "missing", "file.txt"), other)).toBe(true);
	});
});
