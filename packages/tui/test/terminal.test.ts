import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

function withTerminalProcessPatch<T>(
	env: Record<string, string | undefined>,
	fn: () => T,
): { result: T; writes: string[] } {
	const writes: string[] = [];
	const previousEnv = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(env)) {
		previousEnv.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	const stdoutWriteDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
	const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const stdinIsRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const stdinResumeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "resume");
	const processKillDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");

	try {
		Object.defineProperty(process.stdout, "write", {
			configurable: true,
			value: (
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			): boolean => {
				writes.push(typeof chunk === "string" ? chunk : chunk.toString());
				if (typeof encodingOrCallback === "function") {
					encodingOrCallback();
				} else {
					callback?.();
				}
				return true;
			},
		});
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: () => process.stdin,
		});
		Object.defineProperty(process.stdin, "isRaw", {
			configurable: true,
			value: false,
		});
		Object.defineProperty(process.stdin, "resume", {
			configurable: true,
			value: () => process.stdin,
		});
		Object.defineProperty(process, "kill", {
			configurable: true,
			value: () => true,
		});
		Object.defineProperty(globalThis, "setTimeout", {
			configurable: true,
			value: () => undefined,
		});
		return { result: fn(), writes };
	} finally {
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (stdoutWriteDescriptor) Object.defineProperty(process.stdout, "write", stdoutWriteDescriptor);
		else Reflect.deleteProperty(process.stdout, "write");
		if (stdinSetRawModeDescriptor) Object.defineProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		else Reflect.deleteProperty(process.stdin, "setRawMode");
		if (stdinIsRawDescriptor) Object.defineProperty(process.stdin, "isRaw", stdinIsRawDescriptor);
		else Reflect.deleteProperty(process.stdin, "isRaw");
		if (stdinResumeDescriptor) Object.defineProperty(process.stdin, "resume", stdinResumeDescriptor);
		else Reflect.deleteProperty(process.stdin, "resume");
		if (processKillDescriptor) Object.defineProperty(process, "kill", processKillDescriptor);
		else Reflect.deleteProperty(process, "kill");
		if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
		else Reflect.deleteProperty(globalThis, "setTimeout");
	}
}

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal keyboard negotiation", () => {
	it("requests modifyOtherKeys immediately when running inside tmux", () => {
		const givenTmuxEnv = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" };
		const { writes } = withTerminalProcessPatch(givenTmuxEnv, () => {
			const terminal = new ProcessTerminal();

			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();
		});

		const whenModifyOtherKeysIndex = writes.indexOf("\x1b[>4;2m");
		const whenBracketedPasteIndex = writes.indexOf("\x1b[?2004h");
		const whenQueryIndex = writes.indexOf("\x1b[?u");
		const whenDisableIndex = writes.indexOf("\x1b[>4;0m");

		assert.notStrictEqual(whenModifyOtherKeysIndex, -1);
		assert.ok(whenModifyOtherKeysIndex > whenBracketedPasteIndex);
		assert.ok(whenModifyOtherKeysIndex < whenQueryIndex);
		assert.notStrictEqual(whenDisableIndex, -1);
	});
});
