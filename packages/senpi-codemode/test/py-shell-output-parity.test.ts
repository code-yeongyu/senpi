import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { hasPython3, liveKernel } from "./py-kernel/fixtures.ts";

const pythonPath = process.env.PYTHON ?? "python3";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stdoutChunks(messages: readonly KernelToHostMessage[]): readonly string[] {
	return messages.flatMap((message) => (message.type === "text" && message.stream === "stdout" ? [message.data] : []));
}

async function runPythonCell(
	code: string,
	timeoutMs = 10_000,
): Promise<{
	readonly result: Extract<KernelToHostMessage, { type: "result" }>;
	readonly messages: readonly KernelToHostMessage[];
}> {
	const messages: KernelToHostMessage[] = [];
	const kernel = await liveKernel({ onMessage: (message) => messages.push(message) });
	try {
		const result = await kernel.run({ cellId: `shell-${crypto.randomUUID()}`, code, timeoutMs });
		return { result, messages };
	} finally {
		await kernel.close();
	}
}

describe.skipIf(!(await hasPython3()))("Python shell output parity", () => {
	it("Given positional offset and limit when read runs then the requested lines are returned", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-py-read-positional-"));
		const file = join(root, "lines.txt");
		try {
			await writeFile(file, "one\ntwo\nthree\nfour\n");

			// When
			const run = await runPythonCell(`print(read(${JSON.stringify(file)}, 2, 2))`);

			// Then
			expect(run.result.ok).toBe(true);
			expect(stdoutChunks(run.messages).join("")).toContain("two\nthree");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("Given delayed shell output when a bang command runs then chunks stream before the result summary", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first\\n')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second\\n')",
			"sys.stdout.flush()",
		].join(";");

		// When
		const run = await runPythonCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('return=' + str(result.returncode) + ' lines=' + repr(list(result)))",
			].join("\n"),
		);

		// Then
		const stdout = stdoutChunks(run.messages);
		expect(stdout[0]).toBe("first\n");
		expect(stdout.join("")).toContain("second\n");
		expect(stdout.join("")).toContain("return=0 lines=['first', 'second']");
	});

	it("Given more than 3000 shell lines when a bang command runs then output and capture end with one notice", async () => {
		const child = ["import sys", "sys.stdout.write(('x' + chr(10)) * 3100)", "sys.stdout.flush()"].join(";");

		// When
		const run = await runPythonCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('captured=' + str(len(result)) + ' return=' + str(result.returncode))",
			].join("\n"),
		);

		// Then
		const stdout = stdoutChunks(run.messages).join("");
		expect(stdout).toContain("[output truncated: shell helper exceeded");
		expect(stdout).toContain("captured=3000 return=0");
		expect(stdout).not.toContain("captured=3100");
	});

	it("Given shell output beyond one MiB without newlines when a bang command runs then bytes are capped with one notice", async () => {
		const child = ["import sys", "sys.stdout.write('z' * (1024 * 1024 + 17))", "sys.stdout.flush()"].join(";");

		// When
		const run = await runPythonCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('capturedChars=' + str(len(result.n)) + ' return=' + str(result.returncode))",
			].join("\n"),
			15_000,
		);

		// Then
		const stdout = stdoutChunks(run.messages).join("");
		expect(stdout).toContain("[output truncated: shell helper exceeded");
		expect(stdout).toContain("capturedChars=1048576 return=0");
		expect(stdout).not.toContain("capturedChars=1048593");
	});

	it("Given delayed newline-free bash output when a cell magic runs then the first chunk arrives before EOF", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second')",
			"sys.stdout.flush()",
		].join(";");

		// When
		const run = await runPythonCell(`%%bash\n${pythonPath} -c ${shellQuote(child)}`);

		// Then
		const stdout = stdoutChunks(run.messages);
		expect(stdout[0]).toBe("first");
		expect(stdout.join("")).toBe("firstsecond");
	});
});
