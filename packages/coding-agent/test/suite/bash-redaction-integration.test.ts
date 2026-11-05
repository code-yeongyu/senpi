import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import * as toolChildLaunch from "../../src/modes/rpc/tool-child/launch.ts";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe.skipIf(process.platform === "win32")("real bash redaction across runtimes", () => {
	const runtimes = [
		{ toolRuntime: "in-process", terminal: false, user: false },
		{ toolRuntime: "child", terminal: false, user: false },
		{ toolRuntime: "in-process", terminal: true, user: false },
		{ toolRuntime: "child", terminal: true, user: false },
		{ toolRuntime: "in-process", terminal: false, user: true },
		{ toolRuntime: "child", terminal: false, user: true },
	] as const;
	it.each(runtimes.flatMap((runtime) => [undefined, false, true].map((enabled) => ({ ...runtime, enabled }))))(
		"applies redaction to stdout, stderr and transcripts on $toolRuntime (terminal=$terminal, user=$user, enabled=$enabled)",
		async ({ toolRuntime, terminal, user, enabled }) => {
			// Source-checkout children need the same resolver used by the tool-child job tests.
			const launch = vi.spyOn(toolChildLaunch, "toolChildCommand").mockResolvedValue({
				command: process.execPath,
				args: [
					"--import",
					pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href,
					resolve(import.meta.dirname, "../../src/tool-child-main.ts"),
				],
			});
			const harness = await createHarness({
				toolRuntime,
				persistSession: true,
				fileSettings: true,
				settings: enabled === undefined ? {} : { tools: { bash: { redactSecretsInOutput: enabled } } },
				extensionFactories: terminal ? [registerTerminalExtension] : [],
			});
			try {
				await harness.session.bindExtensions({});
				const fixtures = secretOutputCases();
				const input = fixtures.map(({ input }) => input).join("\n") + "\n";
				const expected = enabled ? fixtures.map(({ expected }) => expected).join("\n") + "\n" : input;
				const script = `const x=Buffer.from("${Buffer.from(input).toString("base64")}","base64");process.stdout.write(x);process.stderr.write(x);`;
				const command = `${JSON.stringify(process.execPath)} -e '${script}'`;
				if (user) {
					harness.setResponses([fauxAssistantMessage("ready")]);
					await harness.session.prompt("Initialize the synthetic session.");
					const chunks: string[] = [];
					const result = await harness.session.executeBash(command, (chunk) => chunks.push(chunk));
					expect(result.output.trimEnd()).toBe((expected + expected).trimEnd());
					expect(chunks.join("").trimEnd()).toBe((expected + expected).trimEnd());
				} else {
					harness.setResponses([
						fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("Run synthetic terminal probe.");
					const result = harness.session.messages.find((message) => message.role === "toolResult");
					expect(getMessageText(result).trimEnd()).toBe((expected + expected).trimEnd());
				}
				const sessionFile = harness.sessionManager.getSessionFile();
				assert(sessionFile);
				const entries = readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const persisted = entries.find(
					(entry) => entry.type === "message" && entry.message?.role === (user ? "bashExecution" : "toolResult"),
				);
				assert(persisted);
				expect((user ? persisted.message.output : getMessageText(persisted.message)).trimEnd()).toBe(
					(expected + expected).trimEnd(),
				);
			} finally {
				launch.mockRestore();
				harness.cleanup();
			}
		},
		90_000,
	);
});
