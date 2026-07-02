import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as tuiModule from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

process.env.PI_TUI_TEST_SEAMS = "1";

const STRICT_ENV = "PI_TUI_STRICT_RENDER";

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

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

class DifferentThrowingComponent extends ThrowingComponent {}

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
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-render-contract-"));
	try {
		return await withEnv({ HOME: home }, () => run(home));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function renderErrorStats(): { readonly writes: number } {
	const stats = tuiModule.__renderErrorLogStats?.();
	if (stats !== undefined) {
		return stats;
	}
	throw new Error("render error log stats seam must be enabled");
}

describe("TUI render contract", () => {
	it("renders fallback for a throwing component when debug logging cannot write", async () => {
		await withEnv({ HOME: "/dev/null", [STRICT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(50, 4);
			const tui = new tuiModule.TUI(terminal);
			tui.addChild(new ThrowingComponent());

			await assert.doesNotReject(() => driveRender(tui, terminal));
			assert.ok(terminal.getViewport().join("\n").includes("[render error: ThrowingComponent]"));
			tui.stop();
		});
	});

	it("renders fallback for a throwing component and continues on a subsequent frame", async () => {
		await withTempHome(async () => {
			const terminal = new LoggingVirtualTerminal(50, 4);
			const tui = new tuiModule.TUI(terminal);
			const component = new ThrowingComponent();
			const after = new MutableComponent();
			after.lines = ["after survives"];
			tui.addChild(component);
			tui.addChild(after);
			tui.setFocus(component);

			await driveRender(tui, terminal);
			assert.strictEqual(component.focused, true);
			assert.ok(terminal.getViewport().join("\n").includes("[render error: ThrowingComponent]"));
			assert.ok(terminal.getViewport().join("\n").includes("after survives"));

			terminal.clearWrites();
			after.lines = ["next frame"];
			await driveRender(tui, terminal);
			assert.ok(terminal.getViewport().join("\n").includes("next frame"));
			tui.stop();
		});
	});

	it("truncates an over-wide raw component and continues in release with test seams enabled", async () => {
		await withTempHome(async () => {
			await withEnv({ [STRICT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
				const terminal = new LoggingVirtualTerminal(12, 4);
				const tui = new tuiModule.TUI(terminal);
				const component = new RawOverWideComponent();
				component.line = "short";
				tui.addChild(component);
				await driveRender(tui, terminal);

				component.line = "x".repeat(30);
				await driveRender(tui, terminal);
				assert.strictEqual(visibleWidth(terminal.getViewport()[0] ?? ""), 12);
				assert.ok(terminal.getWrites().includes("x".repeat(12)));

				component.line = "ok";
				await driveRender(tui, terminal);
				assert.strictEqual(terminal.getViewport()[0], "ok");
				tui.stop();
			});
		});
	});

	it("truncates an over-wide raw component when crash logging cannot write in release", async () => {
		await withEnv({ HOME: "/dev/null", [STRICT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(12, 4);
			const tui = new tuiModule.TUI(terminal);
			const component = new RawOverWideComponent();
			component.line = "short";
			tui.addChild(component);
			await driveRender(tui, terminal);

			component.line = "x".repeat(30);
			await assert.doesNotReject(() => driveRender(tui, terminal));
			assert.strictEqual(visibleWidth(terminal.getViewport()[0] ?? ""), 12);
			assert.ok(terminal.getWrites().includes("x".repeat(12)));
			tui.stop();
		});
	});

	it("strict mode throws for an over-wide raw component", () => {
		return withTempHome(async () => {
			await withEnv({ [STRICT_ENV]: "1", PI_TUI_TEST_SEAMS: "1" }, async () => {
				const terminal = new LoggingVirtualTerminal(12, 4);
				const tui = new tuiModule.TUI(terminal);
				const component = new RawOverWideComponent();
				component.line = "short";
				tui.addChild(component);
				await driveRender(tui, terminal);

				component.line = "x".repeat(30);
				const render = Reflect.get(tui, "doRender");
				assert.strictEqual(typeof render, "function");
				assert.throws(() => Reflect.apply(render, tui, []), /exceeds terminal width/);
			});
		});
	});

	it("writes a single crash dump across two over-wide release frames", async () => {
		await withTempHome(async (home) => {
			await withEnv({ [STRICT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
				const terminal = new LoggingVirtualTerminal(12, 4);
				const tui = new tuiModule.TUI(terminal);
				const component = new RawOverWideComponent();
				component.line = "short";
				tui.addChild(component);
				await driveRender(tui, terminal);

				component.line = "x".repeat(30);
				await driveRender(tui, terminal);
				const crashLogPath = path.join(home, ".senpi", "agent", "senpi-crash.log");
				assert.ok(fs.existsSync(crashLogPath));
				fs.chmodSync(crashLogPath, 0o444);

				component.line = "y".repeat(30);
				await driveRender(tui, terminal);
				assert.ok(terminal.getViewport()[0]?.includes("y".repeat(12)));
				tui.stop();
			});
		});
	});

	it("logs render errors once per component class", async () => {
		await withTempHome(async () => {
			const initial = renderErrorStats().writes;
			const terminal = new LoggingVirtualTerminal(50, 4);
			const tui = new tuiModule.TUI(terminal);
			tui.addChild(new ThrowingComponent());

			await driveRender(tui, terminal);
			await driveRender(tui, terminal);
			assert.strictEqual(renderErrorStats().writes, Math.max(initial, 1));

			tui.addChild(new DifferentThrowingComponent());
			await driveRender(tui, terminal);
			assert.strictEqual(renderErrorStats().writes, Math.max(initial, 1) + 1);
			tui.stop();
		});
	});
});
