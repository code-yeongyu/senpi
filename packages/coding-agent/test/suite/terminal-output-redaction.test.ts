import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";

const pty = vi.hoisted(() => {
	class TerminalSession {
		private data = new Set<(chunk: Uint8Array) => void>();
		private exit = new Set<() => void>();
		constructor() {
			pty.sessions.push(this);
		}
		onData(fn: (chunk: Uint8Array) => void) {
			this.data.add(fn);
			return () => this.data.delete(fn);
		}
		onExit(fn: () => void) {
			this.exit.add(fn);
			return () => this.exit.delete(fn);
		}
		start() {}
		emit(text: string) {
			for (const fn of this.data) fn(new TextEncoder().encode(text));
		}
		finish() {
			for (const fn of this.exit) fn();
		}
	}
	class TerminalScreen {
		text = "";
		feed(text: string) {
			this.text += text;
			return Promise.resolve();
		}
		flush() {
			return Promise.resolve();
		}
		snapshot() {
			return { visibleGrid: [this.text], scrollback: [], cols: 120, rows: 40, cursor: { x: 0, y: 0 } };
		}
		dispose() {}
	}
	return { TerminalSession, TerminalScreen, sessions: [] as TerminalSession[] };
});
vi.mock("@earendil-works/pi-pty", () => pty);

import { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { loadTerminalSettings } from "../../src/core/extensions/builtin/terminal/settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("persistent terminal output redaction", () => {
	it("keeps a PEM opener and body private across idle pauses", async () => {
		vi.useFakeTimers();
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: true });
		const session = pty.sessions.at(-1);
		const fixture = secretOutputCases().find(({ name }) => name === "PEM");
		assert(session && fixture);
		try {
			for (const character of fixture.input) {
				session.emit(character);
				await vi.advanceTimersByTimeAsync(100);
				expect(["", "<redacted>"]).toContain(runtime.fullOutput());
			}
			session.finish();
			await runtime.screenReleased();
			expect(runtime.fullOutput()).toBe("<redacted>");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			runtime.dispose();
			vi.useRealTimers();
		}
	});
	// senpi#4358: fragments below a full public prefix remain ordinary output.
	it.each([
		"Enter name",
		"\x1b[10;5H",
		"Enter name\x1b[10;5H",
		"I",
		"e.g.",
		"git",
		"sk",
		"AI",
		"s",
		"g",
		"x",
		"A",
		"AK",
		"e",
		"C",
		"D",
		"eye",
	])("flushes idle prompt text and complete controls: %j", async (input) => {
		vi.useFakeTimers();
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: true });
		const session = pty.sessions.at(-1);
		assert(session);
		const observed: string[] = [];
		runtime.onOutput((text) => observed.push(text));
		try {
			session.emit(input);
			await vi.advanceTimersByTimeAsync(100);
			expect(observed.join("")).toBe(input);
			expect(runtime.readDelta().text).toBe(input);
			expect(runtime.snapshot().visibleGrid).toEqual([input]);
			session.emit(" next\n");
			expect(runtime.fullOutput()).toBe(`${input} next\n`);
		} finally {
			runtime.dispose();
			expect(vi.getTimerCount()).toBe(0);
			vi.useRealTimers();
		}
	});
	it("preserves ordinary words continued across repeated idle pauses", async () => {
		vi.useFakeTimers();
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: true });
		const session = pty.sessions.at(-1);
		assert(session);
		try {
			for (const part of ["going to s", "l", "eep now"]) {
				session.emit(part);
				await vi.advanceTimersByTimeAsync(100);
			}
			expect(runtime.fullOutput()).toBe("going to sleep now");
			session.finish();
			await runtime.screenReleased();
			expect(runtime.fullOutput()).toBe("going to sleep now");
		} finally {
			runtime.dispose();
			vi.useRealTimers();
		}
	});
	it("re-evaluates secrets split at every idle boundary and suppresses their completion", async () => {
		vi.useFakeTimers();
		try {
			for (const fixture of secretOutputCases().filter(({ name }) => /^(prefix|AWS|Google|JWT)/.test(name))) {
				const minimumLength = fixture.name.startsWith("prefix")
					? fixture.input.startsWith("sk-")
						? 3
						: fixture.input.indexOf("synthetic")
					: fixture.name === "JWT"
						? 3
						: 4;
				for (let split = 1; split < fixture.input.length; split++) {
					const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: true });
					const session = pty.sessions.at(-1);
					assert(session);
					try {
						session.emit(fixture.input.slice(0, split));
						await vi.advanceTimersByTimeAsync(100);
						const released = split < minimumLength ? fixture.input.slice(0, split) : "";
						expect(runtime.fullOutput()).toBe(released);
						await vi.advanceTimersByTimeAsync(100);
						expect(runtime.fullOutput()).toBe(released);
						session.emit(`${fixture.input.slice(split)} done\n`);
						expect(runtime.fullOutput()).toBe(`${released}<redacted> done\n`);
						expect(runtime.fullOutput()).not.toContain(fixture.input);
					} finally {
						runtime.dispose();
					}
				}
			}
		} finally {
			vi.useRealTimers();
		}
	});
	it("loads the opt-in setting and defaults to off", () => {
		expect(loadTerminalSettings(SettingsManager.inMemory()).redactSecretsInOutput).toBe(false);
		expect(
			loadTerminalSettings(
				SettingsManager.inMemory({
					tools: { bash: { redactSecretsInOutput: true } },
				}),
			).redactSecretsInOutput,
		).toBe(true);
	});
	it("withholds a split Bearer body from observers, retained output and screen", async () => {
		vi.useFakeTimers();
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: true });
		const session = pty.sessions.at(-1);
		assert(session);
		const observed: string[] = [];
		runtime.onOutput((text) => observed.push(text));
		try {
			for (const part of ["Bearer ", "abcdef", "1-ghijklmnop"]) {
				session.emit(part);
				await vi.advanceTimersByTimeAsync(100);
				expect(runtime.fullOutput()).toBe("Bearer ");
				expect(observed.join("")).toBe("Bearer ");
				expect(runtime.snapshot().visibleGrid).toEqual(["Bearer "]);
			}
			expect(runtime.readDelta().text).toBe("Bearer ");
			session.finish();
			await runtime.screenReleased();
			expect(runtime.readDelta().text).toBe("<redacted>");
			expect(runtime.fullOutput()).toBe("Bearer <redacted>");
			expect(observed.join("")).toBe("Bearer <redacted>");
			expect(runtime.snapshot().visibleGrid).toEqual(["Bearer <redacted>"]);
		} finally {
			runtime.dispose();
			vi.useRealTimers();
		}
	});

	it.each([false, true])("protects observers, delta, retained output and screen (enabled=%s)", async (enabled) => {
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: enabled });
		const session = pty.sessions.at(-1);
		assert(session);
		const observed: string[] = [];
		runtime.onOutput((text) => observed.push(text));
		const fixtures = secretOutputCases();
		const input = fixtures.map(({ input }) => input).join("\n");
		const expected = enabled ? fixtures.map(({ expected }) => expected).join("\n") : input;
		try {
			for (const character of input) {
				session.emit(character);
				if (enabled) expect(expected.startsWith(observed.join(""))).toBe(true);
			}
			session.finish();
			await runtime.screenReleased();
			expect(runtime.fullOutput()).toBe(expected);
			expect(runtime.readDelta().text).toBe(expected);
			expect(runtime.readDelta().text).toBe("");
			expect(observed.join("")).toBe(expected);
			expect(runtime.snapshot().visibleGrid).toEqual([expected]);
		} finally {
			runtime.dispose();
		}
	});
});
