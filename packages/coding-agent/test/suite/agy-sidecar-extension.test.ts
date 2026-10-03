import { watch } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import agySidecarExtension, { decodeAgyOutput } from "../../src/core/extensions/builtin/agy-sidecar.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

async function createAgyHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [agySidecarExtension] });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const executable = join(harness.tempDir, "agy-fixture");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const task = args[args.indexOf("-p") + 1];
if (task === "wait") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(process.cwd(), "agy-started"), String(process.pid));
  setInterval(() => {}, 1000);
} else if (task === "overflow") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(process.cwd(), "agy-overflow-started"), String(process.pid));
  process.stdout.write("x".repeat(3 * 1024 * 1024));
} else if (task === "long") {
  process.stderr.write("command(git) was denied by AGY permissions\\n");
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: "The work completed.\\n" + Array.from({ length: 2100 }, (_, index) => "detail " + index).join("\\n"),
  }));
} else if (task === "fail") {
  process.stdout.write(JSON.stringify({ status: "ERROR", error: "invalid model", response: "" }));
} else {
  process.stderr.write("command(git) was denied by AGY permissions\\n");
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    conversation_id: "fixture-conversation",
    response: JSON.stringify({
      task,
      cwd: process.cwd(),
      args,
      inheritedOmoAuth: Boolean(process.env.OMO_CODING_AGENT_DIR),
    }),
  }));
}
`,
		{ mode: 0o755 },
	);
	vi.stubEnv("SENPI_AGY_EXECUTABLE", executable);
	return harness;
}

afterEach(() => {
	vi.unstubAllEnvs();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("AGY sidecar extension", () => {
	it("delegates through the real process boundary and reports permission diagnostics", async () => {
		// Given: a CLI-shaped executable and an inherited OmO agent-directory variable.
		const harness = await createAgyHarness();
		vi.stubEnv("OMO_CODING_AGENT_DIR", "/private/omo-auth");

		// When: OmO executes the registered sidecar tool.
		const result = await harness.session.executeTool("agy", {
			task: "inspect this repository",
			model: "gemini-3.8-flash",
		});

		// Then: AGY receives its own cwd and model, without OmO credentials.
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Expected AGY text output");
		const response = content.text.slice(content.text.lastIndexOf("\n\n") + 2);
		expect(JSON.parse(response)).toMatchObject({
			task: "inspect this repository",
			cwd: await realpath(harness.tempDir),
			inheritedOmoAuth: false,
			args: expect.arrayContaining(["--output-format", "json", "--mode", "plan", "--model", "gemini-3.8-flash"]),
		});
		expect(content.text).toContain("command(git) was denied by AGY permissions");
		expect(result.details).toMatchObject({ conversationId: "fixture-conversation", truncated: false });
	});

	it("rejects an AGY error envelope even when the process exits zero", async () => {
		// Given: an AGY response reporting failure without a nonzero exit.
		const harness = await createAgyHarness();

		// When / Then: the delegated task fails rather than looking complete.
		const result = await harness.session.executeTool("agy", { task: "fail" });
		expect(result.details).toMatchObject({ isError: true });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("AGY ERROR") });
	});

	it("keeps denied-action diagnostics visible when a long response is truncated", async () => {
		// Given: AGY reports success, but its long answer conceals a permission denial.
		const harness = await createAgyHarness();

		// When: OmO truncates the response to its tool budget.
		const result = await harness.session.executeTool("agy", { task: "long" });

		// Then: the denial still precedes the apparent success claim.
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Expected AGY text output");
		expect(content.text).toContain("command(git) was denied by AGY permissions");
		expect(content.text.indexOf("denied")).toBeLessThan(content.text.indexOf("The work completed."));
		expect(result.details).toMatchObject({ truncated: true });
	});

	it("kills a SIGTERM-resistant AGY child when stdout exceeds the hard limit", async () => {
		// Given: AGY ignores SIGTERM and emits more than 2 MiB.
		const harness = await createAgyHarness();

		// When: the tool's response cap is reached.
		const result = await harness.session.executeTool("agy", { task: "overflow" });

		// Then: the process has exited rather than surviving behind an error message.
		expect(result.details).toMatchObject({ isError: true });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("2 MiB") });
		const pid = Number(await readFile(join(harness.tempDir, "agy-overflow-started"), "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("decodes a UTF-8 character split across subprocess chunks", () => {
		// Given: the three bytes for one character arrive in separate chunks.
		const character = Buffer.from("你", "utf8");
		const chunks = [Buffer.from("hello "), character.subarray(0, 1), character.subarray(1, 2), character.subarray(2)];

		// When / Then: the same decoder used on AGY stdout preserves the original text.
		expect(decodeAgyOutput(chunks)).toBe("hello 你");
	});

	it("terminates the AGY subprocess when the tool is cancelled", async () => {
		// Given: a filesystem event subscribed before starting a long-running AGY task.
		const harness = await createAgyHarness();
		const started = Promise.withResolvers<void>();
		const watcher = watch(harness.tempDir, (_event, filename) => {
			if (filename === "agy-started") started.resolve();
		});
		const controller = new AbortController();
		try {
			// When: AGY starts, cancel the tool's execution signal.
			const execution = harness.session.executeTool("agy", { task: "wait" }, { signal: controller.signal });
			const deadline = setTimeout(() => started.reject(new Error("AGY never started")), 5000);
			try {
				await started.promise;
			} finally {
				clearTimeout(deadline);
			}
			controller.abort();

			// Then: the tool reports cancellation rather than hanging or returning success.
			const result = await execution;
			expect(result.details).toMatchObject({ isError: true });
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("cancelled") });
			const pid = Number(await readFile(join(harness.tempDir, "agy-started"), "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			watcher.close();
		}
	});
});
