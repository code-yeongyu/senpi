import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { isMultiplexerSession, useLegacyMuxRender, viewportRenderEnabled } from "../src/mux.ts";

const ENV_KEYS = ["TMUX", "TMUX_PANE", "STY", "ZELLIJ", "PI_TUI_LEGACY_MUX_RENDER", "PI_TUI_VIEWPORT_RENDER"] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const originalEnv = new Map<EnvKey, string | undefined>();

for (const key of ENV_KEYS) {
	originalEnv.set(key, process.env[key]);
}

function clearEnv(): void {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreEnv();
});

describe("isMultiplexerSession", () => {
	it("returns true when each multiplexer environment variable is set alone", () => {
		for (const key of ["TMUX", "TMUX_PANE", "STY", "ZELLIJ"] as const) {
			clearEnv();

			process.env[key] = "x";

			assert.equal(isMultiplexerSession(), true, key);
		}
	});

	it("returns false when multiplexer environment variables are unset", () => {
		clearEnv();

		assert.equal(isMultiplexerSession(), false);
	});

	it("returns false for empty multiplexer environment strings", () => {
		clearEnv();
		process.env.TMUX = "";
		process.env.TMUX_PANE = "";
		process.env.STY = "";
		process.env.ZELLIJ = "";

		assert.equal(isMultiplexerSession(), false);
	});

	it("reads environment variables at call time after import", () => {
		clearEnv();
		assert.equal(isMultiplexerSession(), false);

		process.env.ZELLIJ = "0";
		assert.equal(isMultiplexerSession(), true);

		process.env.ZELLIJ = "";
		assert.equal(isMultiplexerSession(), false);
	});
});

describe("useLegacyMuxRender", () => {
	it("returns true only when the legacy render switch is exactly 1", () => {
		clearEnv();
		process.env.PI_TUI_LEGACY_MUX_RENDER = "1";
		assert.equal(useLegacyMuxRender(), true);

		for (const value of ["", "0", "true", "yes"] as const) {
			process.env.PI_TUI_LEGACY_MUX_RENDER = value;

			assert.equal(useLegacyMuxRender(), false, value);
		}
	});
});

describe("viewportRenderEnabled", () => {
	it("returns true only when the viewport render switch is exactly 1", () => {
		clearEnv();
		process.env.PI_TUI_VIEWPORT_RENDER = "1";
		assert.equal(viewportRenderEnabled(), true);

		for (const value of ["", "0", "true", "yes"] as const) {
			process.env.PI_TUI_VIEWPORT_RENDER = value;

			assert.equal(viewportRenderEnabled(), false, value);
		}
	});
});
