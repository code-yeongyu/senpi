/**
 * herdr Kitty-graphics probe (#3698).
 *
 * herdr panes set TERM_PROGRAM=herdr / HERDR_ENV=1, which matches no known
 * terminal, so env-only detection reports no image support and tool images
 * fall back to `[image: <mime>]` placeholders. Under herdr the only truthful
 * answer comes from asking the terminal chain itself: send a Kitty graphics
 * query, enable kitty only on an OK reply, and keep the placeholder when the
 * probe fails or times out.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Component, Terminal, TUI } from "../src/index.ts";
import { TuiMainScreen } from "../src/index.ts";
import { buildKittyGraphicsQuery, parseKittyGraphicsProbeResponse } from "../src/kitty-graphics-probe.ts";
import {
	detectCapabilities,
	getCapabilities,
	resetCapabilitiesCache,
	setProbedImageProtocol,
} from "../src/terminal-image.ts";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"TMUX_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"VSCODE_IPC_HOOK_CLI",
	"VSCODE_GIT_IPC_HANDLE",
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	}
}

const herdrEnv = {
	TERM_PROGRAM: "herdr",
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w46:p5E",
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
} as const;

function resetProbeLatch(): void {
	setProbedImageProtocol(undefined);
	resetCapabilitiesCache();
}

describe("herdr detection (#3698)", () => {
	afterEach(resetProbeLatch);

	it("asks for a Kitty graphics probe under herdr panes instead of guessing from env", () => {
		withEnv({ ...herdrEnv }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
		});
	});

	it("keeps the herdr probe for a herdr pane started from a VS Code terminal (#2826)", () => {
		withEnv({ ...herdrEnv, VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc-1.sock" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.imageProbe, "kitty");
			assert.strictEqual(caps.hyperlinks, false);
		});
	});

	it("keeps the herdr probe when only HERDR_ENV and the inherited VS Code marker are set (#2826)", () => {
		withEnv(
			{ HERDR_ENV: "1", TERM: "xterm-256color", VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc-1.sock" },
			() => {
				const caps = detectCapabilities();
				assert.strictEqual(caps.imageProbe, "kitty");
				assert.strictEqual(caps.hyperlinks, false);
			},
		);
	});

	it("recognizes herdr via HERDR_ENV alone", () => {
		withEnv({ HERDR_ENV: "1", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, "kitty");
		});
	});

	it("PI_IMAGE_PROTOCOL=kitty under herdr skips the probe", () => {
		withEnv({ ...herdrEnv, PI_IMAGE_PROTOCOL: "kitty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imageProbe, undefined);
		});
	});

	it("PI_IMAGE_PROTOCOL=none under herdr skips the probe and keeps images off", () => {
		withEnv({ ...herdrEnv, PI_IMAGE_PROTOCOL: "none" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, undefined);
		});
	});

	it("records the probe result in a latch that survives capability cache resets", () => {
		withEnv({ ...herdrEnv }, () => {
			setProbedImageProtocol("kitty");
			let caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imageProbe, undefined);
			resetCapabilitiesCache();
			caps = getCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imageProbe, undefined);
		});
	});

	it("a failed probe keeps the placeholder and stops re-probing", () => {
		withEnv({ ...herdrEnv }, () => {
			setProbedImageProtocol(null);
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, undefined);
		});
	});

	it("the probe latch never leaks into non-herdr terminals", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			setProbedImageProtocol("kitty");
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, undefined);
		});
	});

	it("tmux keeps precedence over the herdr branch", () => {
		withEnv(
			{
				...herdrEnv,
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TERM: "tmux-256color",
			},
			() => {
				const caps = detectCapabilities(
					() => true,
					() => ({ allowPassthrough: "off", clientTermname: "" }),
				);
				assert.strictEqual(caps.images, null);
				assert.strictEqual(caps.imageProbe, undefined);
			},
		);
	});
});

describe("buildKittyGraphicsQuery", () => {
	it("emits a 1x1 RGBA direct-transmission query for the given image id", () => {
		assert.strictEqual(buildKittyGraphicsQuery(4242), "\x1b_Gi=4242,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
	});
});

describe("parseKittyGraphicsProbeResponse", () => {
	it("accepts a bare OK reply for our id", () => {
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_Gi=4242;OK\x1b\\", 4242), "ok");
	});

	it("accepts an OK reply that echoes the query keys", () => {
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_Gi=4242,a=q,t=d,f=24,s=1,v=1;OK\x1b\\", 4242), "ok");
	});

	it("treats error payloads as a failed probe", () => {
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_Gi=4242;ERR\x1b\\", 4242), "err");
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_Gi=4242;EBADF\x1b\\", 4242), "err");
	});

	it("ignores replies for other image ids and non-APC input", () => {
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_Gi=777;OK\x1b\\", 4242), null);
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b_G;OK\x1b\\", 4242), null);
		assert.strictEqual(parseKittyGraphicsProbeResponse("\x1b[6;18;9t", 4242), null);
		assert.strictEqual(parseKittyGraphicsProbeResponse("x", 4242), null);
	});
});

class ProbeTestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	readonly writes: string[] = [];

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {
		this.inputHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}
}

class EmptyComponent implements Component {
	render(_width: number): string[] {
		return [];
	}

	handleInput(_data: string): void {}

	invalidate(): void {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROBE_QUERY_PATTERN = /^\x1b_Gi=(\d+),s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\$/;

function findProbeQuery(writes: readonly string[]): { id: number; write: string } | undefined {
	for (const write of writes) {
		const match = PROBE_QUERY_PATTERN.exec(write);
		if (match) return { id: Number.parseInt(match[1] ?? "", 10), write };
	}
	return undefined;
}

describe("TuiMainScreen herdr probe wiring (#3698)", () => {
	const savedValues: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedValues[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedValues[key] === undefined) delete process.env[key];
			else process.env[key] = savedValues[key];
		}
		resetProbeLatch();
	});

	function setupHerdr(): { terminal: ProbeTestTerminal; tui: TUI } {
		Object.assign(process.env, herdrEnv);
		resetProbeLatch();
		const terminal = new ProbeTestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyComponent());
		tui.start();
		return { terminal, tui };
	}

	it("sends the graphics query at start and enables kitty on an OK reply", () => {
		const { terminal, tui } = setupHerdr();
		try {
			const probe = findProbeQuery(terminal.writes);
			assert.ok(probe, `expected a Kitty graphics probe write, got: ${JSON.stringify(terminal.writes)}`);
			terminal.sendInput(`\x1b_Gi=${probe.id};OK\x1b\\`);

			const caps = getCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imageProbe, undefined);
			// Cell size becomes relevant the moment images turn on.
			assert.ok(terminal.writes.includes("\x1b[16t"), "expected a CSI 16 t cell-size query after the probe");
		} finally {
			tui.stop();
		}
	});

	it("keeps the placeholder when no terminal answers the probe", async () => {
		const { terminal, tui } = setupHerdr();
		try {
			assert.ok(findProbeQuery(terminal.writes), "expected a Kitty graphics probe write");
			await wait(700);
			const caps = getCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.imageProbe, undefined);
		} finally {
			tui.stop();
		}
	});

	it("consumes the reply so it never reaches focused components", () => {
		const { terminal, tui } = setupHerdr();
		try {
			const component = new (class implements Component {
				readonly inputs: string[] = [];
				render(_width: number): string[] {
					return [];
				}
				handleInput(data: string): void {
					this.inputs.push(data);
				}
				invalidate(): void {}
			})();
			tui.setFocus(component);
			const probe = findProbeQuery(terminal.writes);
			assert.ok(probe);
			terminal.sendInput(`\x1b_Gi=${probe.id};OK\x1b\\`);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("stop() drops the pending probe without recording a failure", async () => {
		const { terminal, tui } = setupHerdr();
		assert.ok(findProbeQuery(terminal.writes));
		tui.stop();
		await wait(700);
		// The latch was never resolved, so a later start() can probe again.
		assert.strictEqual(detectCapabilities().imageProbe, "kitty");
	});

	it("does not probe outside herdr", () => {
		const terminal = new ProbeTestTerminal();
		process.env.TERM_PROGRAM = "vscode";
		resetProbeLatch();
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyComponent());
		tui.start();
		try {
			assert.strictEqual(findProbeQuery(terminal.writes), undefined);
		} finally {
			tui.stop();
		}
	});
});
