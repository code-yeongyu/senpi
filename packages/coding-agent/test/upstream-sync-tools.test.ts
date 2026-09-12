/**
 * Lane L4 (C17) resolution contract for the upstream sync: the built-in tools adopt upstream's
 * renderer split and its unconditional strict-prefer sampling, while keeping every fork execute-path
 * surface (filesystem policy before I/O, the read `local://` guard, write result patches, bash
 * callback/spill hardening) and the env-gated `getExperimentalToolSampling` helper.
 *
 * Every assertion here is on a machine-consumed value: a sampling descriptor, a thrown error
 * message the model sees, a unified patch, or bytes on disk. Failures are observed through the
 * promise the tool returns and through re-reading the file, never through a timer.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getExperimentalToolSampling } from "../src/core/experimental.ts";
import type { ExtensionContext, FilesystemPolicyChecker } from "../src/core/extensions/types.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createAllToolDefinitions, type ToolName } from "../src/core/tools/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const STRICT_PREFER = { type: "json_schema", strict: "prefer" } as const;
const STRICT_TOOLS = ["read", "bash", "powershell", "edit", "write"] as const satisfies readonly ToolName[];
const UNCONSTRAINED_TOOLS = ["grep", "find", "ls"] as const satisfies readonly ToolName[];

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function denyAll(reason: string): FilesystemPolicyChecker {
	return async () => ({ allow: false, reason });
}

/** The built-in tools resolve `ctx?.cwd || cwd`, so an empty context exercises the creation-time cwd. */
const NO_CTX = {} as ExtensionContext;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Body lines of a unified patch, split by their leading marker. */
function patchLines(patch: string): { added: string[]; removed: string[] } {
	const lines = patch.split("\n");
	const bodyStart = lines.findIndex((line) => line.startsWith("@@"));
	const body = bodyStart === -1 ? [] : lines.slice(bodyStart + 1);
	return {
		added: body.filter((line) => line.startsWith("+")).map((line) => line.slice(1)),
		removed: body.filter((line) => line.startsWith("-")).map((line) => line.slice(1)),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("built-in tool sampling after the upstream sync", () => {
	it.each([undefined, "0", "1"])("prefers strict sampling with PI_EXPERIMENTAL=%s", (experimental) => {
		vi.stubEnv("PI_EXPERIMENTAL", experimental);
		const definitions = createAllToolDefinitions(process.cwd());

		for (const name of STRICT_TOOLS) {
			expect(definitions[name].constrainedSampling).toEqual(STRICT_PREFER);
		}
		for (const name of UNCONSTRAINED_TOOLS) {
			expect(definitions[name].constrainedSampling).toBeUndefined();
		}
		// Strictness is a provider-side conversion; the execution schema is untouched.
		expect(definitions.read.parameters.required).toEqual(["path"]);
		expect(definitions.bash.parameters.required).toEqual(["command"]);
	});

	it("keeps getExperimentalToolSampling env-gated instead of folding it into the built-in default", () => {
		vi.stubEnv("SENPI_EXPERIMENTAL", undefined);
		vi.stubEnv("PI_EXPERIMENTAL", undefined);
		expect(getExperimentalToolSampling()).toBeUndefined();

		vi.stubEnv("PI_EXPERIMENTAL", "1");
		expect(getExperimentalToolSampling()).toEqual(STRICT_PREFER);
	});

	it("still exposes a renderer pair for every built-in tool after the renderers/* split", () => {
		const definitions = createAllToolDefinitions(process.cwd());
		for (const name of [...STRICT_TOOLS, ...UNCONSTRAINED_TOOLS]) {
			expect(typeof definitions[name].renderCall).toBe("function");
			expect(typeof definitions[name].renderResult).toBe("function");
		}
	});

	it("keeps the fork bash prompt snippet recommending rg over grep", () => {
		// The fork owns this snippet (see src/core/tools/AGENTS.md); it lands in every system prompt.
		expect(bashToolSystemPromptContribution.snippet).toContain("rg");
		expect(bashToolSystemPromptContribution.snippet).not.toContain("grep");
		expect(createBashToolDefinition("/workspace").promptSnippet).toBe(bashToolSystemPromptContribution.snippet);
	});
});

describe("filesystem policy runs before any tool I/O", () => {
	it("rejects a denied write and leaves the target absent", async () => {
		const cwd = createTempDir("senpi-l4-write-denied-");
		const target = join(cwd, "denied.txt");
		const write = createWriteToolDefinition(cwd, { filesystemPolicy: denyAll("write denied by policy") });

		await expect(
			write.execute("call-1", { path: target, content: "nope" }, undefined, undefined, NO_CTX),
		).rejects.toThrow("write denied by policy");
		expect(existsSync(target)).toBe(false);
	});

	it("rejects a denied edit and leaves the original bytes untouched", async () => {
		const cwd = createTempDir("senpi-l4-edit-denied-");
		const target = join(cwd, "kept.txt");
		writeFileSync(target, "original\n", "utf-8");
		const edit = createEditToolDefinition(cwd, { filesystemPolicy: denyAll("edit denied by policy") });

		await expect(
			edit.execute(
				"call-2",
				{ path: target, edits: [{ oldText: "original", newText: "replaced" }] },
				undefined,
				undefined,
				NO_CTX,
			),
		).rejects.toThrow("edit denied by policy");
		expect(readFileSync(target, "utf-8")).toBe("original\n");
	});

	it("rejects a denied read", async () => {
		const cwd = createTempDir("senpi-l4-read-denied-");
		const target = join(cwd, "secret.txt");
		writeFileSync(target, "classified\n", "utf-8");
		const read = createReadToolDefinition(cwd, { filesystemPolicy: denyAll("read denied by policy") });

		await expect(read.execute("call-3", { path: target }, undefined, undefined, NO_CTX)).rejects.toThrow(
			"read denied by policy",
		);
	});
});

describe("invalid arguments fail before touching the filesystem", () => {
	it("rejects an edit with no replacements and keeps the file byte-identical", async () => {
		const cwd = createTempDir("senpi-l4-edit-invalid-");
		const target = join(cwd, "untouched.txt");
		writeFileSync(target, "first\nsecond\n", "utf-8");
		const before = readFileSync(target);

		const edit = createEditToolDefinition(cwd);
		await expect(edit.execute("call-4", { path: target, edits: [] }, undefined, undefined, NO_CTX)).rejects.toThrow(
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
		expect(readFileSync(target).equals(before)).toBe(true);
	});

	it("rejects a bash call with a non-positive timeout without spawning a shell", async () => {
		const cwd = createTempDir("senpi-l4-bash-invalid-");
		const marker = join(cwd, "should-not-exist.txt");
		const bash = createBashToolDefinition(cwd);

		await expect(
			bash.execute(
				"call-5",
				{ command: `touch ${JSON.stringify(marker)}`, timeout: 0 },
				undefined,
				undefined,
				NO_CTX,
			),
		).rejects.toThrow("Invalid timeout");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("bash output callback failures settle the tool promise", () => {
	it("surfaces a streaming onUpdate rejection as the tool error instead of an uncaught exception", async () => {
		const cwd = createTempDir("senpi-l4-bash-callback-");
		const bash = createBashToolDefinition(cwd);
		const callbackError = new Error("update sink exploded");
		let updates = 0;

		// The first onUpdate is the synchronous empty priming call; the throw goes on the first
		// call that carries streamed output, which is the exact seam the fork hardened.
		const onUpdate = () => {
			updates++;
			if (updates > 1) throw callbackError;
		};

		const error = await bash
			.execute("call-6", { command: "printf 'streamed-output\\n'" }, undefined, onUpdate, NO_CTX)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		expect(error).toBe(callbackError);
		expect(updates).toBeGreaterThan(1);
	});
});

describe("write results carry the patch the app-server diff notification needs", () => {
	it("reports an add whose patch reproduces the bytes on disk", async () => {
		const cwd = createTempDir("senpi-l4-write-add-");
		const target = join(cwd, "created.txt");
		const content = "alpha\nbeta\ngamma\n";
		const write = createWriteToolDefinition(cwd);

		const result = await write.execute("call-7", { path: target, content }, undefined, undefined, NO_CTX);

		expect(textOf(result)).toContain(`Successfully wrote to ${target}`);
		expect(result.details?.operation).toBe("add");
		expect(readFileSync(target, "utf-8")).toBe(content);

		const patch = result.details?.patch ?? "";
		expect(patch.startsWith("--- /dev/null")).toBe(true);
		const { added, removed } = patchLines(patch);
		expect(removed).toEqual([]);
		expect(added).toEqual(readFileSync(target, "utf-8").split("\n").slice(0, -1));
	});

	it("reports an update whose patch matches the real before/after bytes", async () => {
		const cwd = createTempDir("senpi-l4-write-update-");
		const target = join(cwd, "changed.txt");
		const before = "one\ntwo\n";
		const after = "one\nTWO\n";
		writeFileSync(target, before, "utf-8");
		const write = createWriteToolDefinition(cwd);

		const result = await write.execute("call-8", { path: target, content: after }, undefined, undefined, NO_CTX);

		expect(result.details?.operation).toBe("update");
		expect(readFileSync(target, "utf-8")).toBe(after);

		const { added, removed } = patchLines(result.details?.patch ?? "");
		expect(removed).toEqual(["two"]);
		expect(added).toEqual(["TWO"]);
	});

	it("returns no details when a rewrite does not change the bytes", async () => {
		const cwd = createTempDir("senpi-l4-write-noop-");
		const target = join(cwd, "same.txt");
		writeFileSync(target, "identical\n", "utf-8");
		const write = createWriteToolDefinition(cwd);

		const result = await write.execute(
			"call-9",
			{ path: target, content: "identical\n" },
			undefined,
			undefined,
			NO_CTX,
		);

		expect(result.details).toBeUndefined();
		expect(readFileSync(target, "utf-8")).toBe("identical\n");
	});
});

describe("read keeps the fork local:// guard", () => {
	it("explains the eval kernel helpers instead of resolving the URI as a relative path", async () => {
		const cwd = createTempDir("senpi-l4-read-local-uri-");
		const read = createReadToolDefinition(cwd);

		const error = await read
			.execute("call-10", { path: "local://detached-eval-eval_5.log" }, undefined, undefined, NO_CTX)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("local:// URIs resolve only inside eval cells");
		expect(message).toContain("read()");
		expect(message).not.toContain("ENOENT");
	});
});
