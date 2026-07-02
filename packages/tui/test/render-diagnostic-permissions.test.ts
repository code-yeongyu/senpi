import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as tuiModule from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

process.env.PI_TUI_TEST_SEAMS = "1";

const STRICT_ENV = "PI_TUI_STRICT_RENDER";

class MutableComponent implements tuiModule.Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class ThrowingComponent implements tuiModule.Component, tuiModule.Focusable {
	focused = false;

	render(_width: number): string[] {
		throw new Error("render exploded");
	}

	handleInput(_data: string): void {}

	invalidate(): void {}
}

class RawOverWideComponent implements tuiModule.Component {
	line = "";

	render(_width: number): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

async function driveRender(tui: tuiModule.TUI, terminal: VirtualTerminal): Promise<void> {
	const render = Reflect.get(tui, "doRender");
	assert.strictEqual(typeof render, "function");
	Reflect.apply(render, tui, []);
	await terminal.flush();
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previous.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-render-diagnostic-permissions-"));
	try {
		return await withEnv({ HOME: home }, () => run(home));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("TUI diagnostic log permissions", () => {
	it("tightens existing diagnostic log files after debug and crash writes", async () => {
		await withTempHome(async (home) => {
			await withEnv({ [STRICT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
				const agentDir = path.join(home, ".senpi", "agent");
				const debugLogPath = path.join(agentDir, "senpi-debug.log");
				const crashLogPath = path.join(agentDir, "senpi-crash.log");
				fs.mkdirSync(agentDir, { recursive: true });
				fs.writeFileSync(debugLogPath, "existing debug\n", { encoding: "utf8", mode: 0o644 });
				fs.writeFileSync(crashLogPath, "existing crash\n", { encoding: "utf8", mode: 0o644 });
				fs.chmodSync(debugLogPath, 0o644);
				fs.chmodSync(crashLogPath, 0o644);

				const debugTerminal = new VirtualTerminal(50, 4);
				const debugTui = new tuiModule.TUI(debugTerminal);
				debugTui.addChild(new ThrowingComponent());
				await driveRender(debugTui, debugTerminal);
				debugTui.stop();

				assert.strictEqual(fs.statSync(debugLogPath).mode & 0o777, 0o600);

				const crashTerminal = new VirtualTerminal(12, 4);
				const crashTui = new tuiModule.TUI(crashTerminal);
				const component = new RawOverWideComponent();
				component.line = "short";
				crashTui.addChild(component);
				await driveRender(crashTui, crashTerminal);
				component.line = "x".repeat(30);
				await driveRender(crashTui, crashTerminal);
				crashTui.stop();

				assert.strictEqual(fs.statSync(crashLogPath).mode & 0o777, 0o600);
			});
		});
	});

	it("tightens an existing PI_TUI_DEBUG render dump after writing", async () => {
		const timestamp = 1234567890;
		const randomValue = 0.123456789;
		const originalDateNow = Date.now;
		const originalMathRandom = Math.random;
		const debugDir = path.join("/tmp", "tui");
		const debugPath = path.join(debugDir, `render-${timestamp}-${randomValue.toString(36).slice(2)}.log`);

		Date.now = () => timestamp;
		Math.random = () => randomValue;
		try {
			await withEnv({ PI_TUI_DEBUG: "1", PI_TUI_TEST_SEAMS: "1" }, async () => {
				fs.mkdirSync(debugDir, { recursive: true });
				fs.writeFileSync(debugPath, "existing debug dump\n", { encoding: "utf8", mode: 0o644 });
				fs.chmodSync(debugPath, 0o644);

				const terminal = new VirtualTerminal(50, 4);
				const tui = new tuiModule.TUI(terminal);
				const component = new MutableComponent();
				component.lines = ["first frame"];
				tui.addChild(component);
				await driveRender(tui, terminal);

				component.lines = ["second frame"];
				await driveRender(tui, terminal);
				tui.stop();

				assert.strictEqual(fs.statSync(debugPath).mode & 0o777, 0o600);
			});
		} finally {
			Date.now = originalDateNow;
			Math.random = originalMathRandom;
			fs.rmSync(debugPath, { force: true });
		}
	});
});
