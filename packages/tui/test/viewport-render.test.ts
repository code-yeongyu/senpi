import assert from "node:assert";
import { describe, it } from "node:test";
import * as tuiModule from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

process.env.PI_TUI_TEST_SEAMS = "1";

const VIEWPORT_ENV = "PI_TUI_VIEWPORT_RENDER";
const OVERSCAN = 16;

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}
}

class MutableLinesComponent implements tuiModule.Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

class ObservedTui extends tuiModule.TUI {
	normalizedFrame(): readonly string[] {
		return this.previousLines;
	}
}

class StreamingComponent implements tuiModule.Component {
	private tokenCount = 0;
	readonly stableTail = Array.from({ length: 18 }, (_, index) => `stable viewport row ${index}`);

	appendToken(): void {
		this.tokenCount += 1;
	}

	render(_width: number): string[] {
		return [`streamed tokens ${this.tokenCount}`, ...this.stableTail];
	}

	invalidate(): void {}
}

class ExpandableComponent implements tuiModule.Component {
	private expanded = false;
	readonly tail = Array.from({ length: 6 }, (_, index) => `tail row ${index}`);

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(_width: number): string[] {
		if (!this.expanded) {
			return ["session title", "tools", ...this.tail];
		}
		const inserted = Array.from({ length: 16 }, (_, index) => `expanded tool detail ${index}`);
		return ["session title", "tools", ...inserted, ...this.tail];
	}

	invalidate(): void {}
}

class LargeStatusComponent implements tuiModule.Component {
	readonly transcript = Array.from({ length: 5000 }, (_, index) => `transcript line ${index}`);
	status = "status frame initial";

	render(_width: number): string[] {
		return [...this.transcript, this.status];
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

async function captureBytes(
	enabled: boolean,
	run: (tui: tuiModule.TUI, terminal: LoggingVirtualTerminal) => Promise<void>,
): Promise<string> {
	return await withEnv({ [VIEWPORT_ENV]: enabled ? "1" : "0", PI_TUI_TEST_SEAMS: "1" }, async () => {
		const terminal = new LoggingVirtualTerminal(72, 8);
		const tui = new tuiModule.TUI(terminal);
		await run(tui, terminal);
		const writes = terminal.getWrites();
		tui.stop();
		return writes;
	});
}

function isViewportStats(
	value: unknown,
): value is { readonly lastKittyImageScannedLines: number; readonly lastNormalizedLines: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		"lastNormalizedLines" in value &&
		typeof value.lastNormalizedLines === "number" &&
		"lastKittyImageScannedLines" in value &&
		typeof value.lastKittyImageScannedLines === "number"
	);
}

function viewportStats(): { readonly lastKittyImageScannedLines: number; readonly lastNormalizedLines: number } {
	const getStats = Reflect.get(tuiModule, "__viewportRenderStats");
	assert.strictEqual(typeof getStats, "function", "viewport render stats seam must be exported");
	const stats: unknown = Reflect.apply(getStats, undefined, []);
	assert.ok(stats, "viewport render stats seam must be enabled");
	if (!isViewportStats(stats)) {
		throw new Error("viewport render stats should include lastNormalizedLines");
	}
	return stats;
}

describe("viewport-bounded render", () => {
	it("keeps streaming bytes identical when enabled", async () => {
		const run = async (tui: tuiModule.TUI, terminal: LoggingVirtualTerminal): Promise<void> => {
			const component = new StreamingComponent();
			tui.addChild(component);
			await driveRender(tui, terminal);
			for (let index = 0; index < 12; index++) {
				component.appendToken();
				await driveRender(tui, terminal);
			}
		};

		assert.strictEqual(await captureBytes(true, run), await captureBytes(false, run));
	});

	it("escapes to byte-identical behavior for offscreen line-count changes", async () => {
		const run = async (tui: tuiModule.TUI, terminal: LoggingVirtualTerminal): Promise<void> => {
			const component = new ExpandableComponent();
			tui.addChild(component);
			component.setExpanded(true);
			await driveRender(tui, terminal);
			component.setExpanded(false);
			await driveRender(tui, terminal);
		};

		assert.strictEqual(await captureBytes(true, run), await captureBytes(false, run));
	});

	it("escapes to byte-identical behavior for offscreen in-place mutations", async () => {
		const run = async (tui: tuiModule.TUI, terminal: LoggingVirtualTerminal): Promise<void> => {
			const component = new MutableLinesComponent();
			component.lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
			tui.addChild(component);
			await driveRender(tui, terminal);
			component.lines[0] = "line zero changed offscreen";
			await driveRender(tui, terminal);
		};

		assert.strictEqual(await captureBytes(true, run), await captureBytes(false, run));
	});

	it("bounds normalization to the viewport by default when the flag is unset", async () => {
		await withEnv({ [VIEWPORT_ENV]: undefined, PI_TUI_TEST_SEAMS: "1" }, async () => {
			const terminal = new VirtualTerminal(80, 40);
			const tui = new tuiModule.TUI(terminal);
			const component = new LargeStatusComponent();
			tui.addChild(component);

			await driveRender(tui, terminal);
			component.status = "status frame changed";
			await driveRender(tui, terminal);

			assert.ok(viewportStats().lastNormalizedLines <= terminal.rows + 2 * OVERSCAN + 1);
			tui.stop();
		});
	});

	it("normalizes only the viewport plus overscan when one status line changes", async () => {
		await withEnv({ [VIEWPORT_ENV]: "1", PI_TUI_TEST_SEAMS: "1" }, async () => {
			const terminal = new VirtualTerminal(80, 40);
			const tui = new tuiModule.TUI(terminal);
			const component = new LargeStatusComponent();
			tui.addChild(component);

			await driveRender(tui, terminal);
			component.status = "status frame changed";
			await driveRender(tui, terminal);

			assert.ok(viewportStats().lastNormalizedLines <= terminal.rows + 2 * OVERSCAN + 1);
			assert.ok(viewportStats().lastKittyImageScannedLines <= 1);
			tui.stop();
		});
	});

	it("memoizes unchanged lines so opted-out full passes renormalize only new content", async () => {
		await withEnv({ [VIEWPORT_ENV]: "0", PI_TUI_TEST_SEAMS: "1" }, async () => {
			const terminal = new VirtualTerminal(80, 40);
			const tui = new tuiModule.TUI(terminal);
			const component = new LargeStatusComponent();
			tui.addChild(component);

			await driveRender(tui, terminal);
			assert.strictEqual(viewportStats().lastNormalizedLines, component.transcript.length + 1);

			component.status = "status frame changed";
			await driveRender(tui, terminal);

			assert.strictEqual(viewportStats().lastNormalizedLines, 1);
			tui.stop();
		});
	});

	it("reuses normalized history without memo lookups when streaming appends rows", async (t) => {
		const terminal = new VirtualTerminal(80, 40);
		const tui = new tuiModule.TUI(terminal);
		const component = new LargeStatusComponent();
		tui.addChild(component);
		try {
			await driveRender(tui, terminal);
			const memo = Reflect.get(tui, "normalizeMemo");
			assert.ok(memo instanceof Map);
			const lookup = t.mock.method(memo, "get");
			component.transcript.push("new streamed row");
			await driveRender(tui, terminal);
			assert.ok(lookup.mock.callCount() <= 2, "unchanged history should bypass normalization memo hashing");
			assert.ok(terminal.getViewport().some((line) => line.includes("new streamed row")));
		} finally {
			tui.stop();
		}
	});

	it("preserves normalized bytes across duplicates, moved rows, deletion and resize", async () => {
		const terminal = new VirtualTerminal(80, 40);
		const tui = new ObservedTui(terminal);
		const component = new MutableLinesComponent();
		const reset = "\x1b[0m\x1b]8;;\x07";
		const styled = "\x1b[31mred\ttext";
		const image = "\x1b_Ga=T,f=100;AAAA\x1b\\";
		const normalized = new Map([
			[styled, `\x1b[31mred   text${reset}`],
			[image, image],
			["plain", `plain${reset}`],
			["changed", `changed${reset}`],
		]);
		tui.addChild(component);
		try {
			const frames = [
				[styled, "plain", image],
				[styled, "plain", image, styled],
				["plain", styled, styled, image],
				["changed", styled, image],
				[styled, "plain"],
			];
			for (const lines of frames) {
				component.lines = lines;
				await driveRender(tui, terminal);
				assert.deepStrictEqual(
					tui.normalizedFrame(),
					lines.map((line) => normalized.get(line)),
				);
			}
			terminal.resize(60, 30);
			await driveRender(tui, terminal);
			assert.deepStrictEqual(
				tui.normalizedFrame(),
				component.lines.map((line) => normalized.get(line)),
			);
		} finally {
			tui.stop();
		}
	});

	it("recovers clipped component output when the terminal widens", async () => {
		const terminal = new VirtualTerminal(10, 8);
		const tui = new ObservedTui(terminal);
		const component = new MutableLinesComponent();
		component.lines = ["initial"];
		tui.addChild(component);
		// The containment diagnostic is unrelated to this width-change regression.
		Reflect.set(tui, "overWideCrashDumpWritten", true);
		try {
			await driveRender(tui, terminal);
			component.lines = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
			await driveRender(tui, terminal);
			assert.ok(terminal.getViewport()[0].startsWith("ABCDEFGHIJ"));
			terminal.resize(40, 8);
			await driveRender(tui, terminal);
			assert.ok(terminal.getViewport()[0].startsWith("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
		} finally {
			tui.stop();
		}
	});
});
