import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { detectTerminalCapabilities } from "../src/terminal-capabilities.ts";
import {
	detectCapabilities,
	getCapabilities,
	imageFallback,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
} from "../src/terminal-image.ts";
import { WEZTERM_WINDOWS_IMAGES_HINT } from "../src/wezterm-windows-images.ts";

const OLD_STABLE = "20240203-110809-5046fc22";
const LAST_BAD = "20250208-160105-0123abcd";
const FIRST_GOOD = "20250208-160106-4accc376";
const NIGHTLY = "20261010-084512-a1b2c3d4";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
// Every variable the detection reads, so the developer's own terminal cannot decide a result.
const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"TMUX_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"PI_TUI_TMUX_KITTY_PLACEMENT",
	"PI_TUI_TMUX_KITTY_TERMINAL",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
];

function onPlatform<T>(platform: NodeJS.Platform, env: Record<string, string>, fn: () => T): T {
	const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return fn();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const detectOn = (platform: NodeJS.Platform, env: Record<string, string>) =>
	onPlatform(platform, env, () => detectCapabilities());

const wezterm = (version?: string): Record<string, string> =>
	version === undefined
		? { WEZTERM_PANE: "1", TERM_PROGRAM: "WezTerm" }
		: { WEZTERM_PANE: "1", TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: version };

describe("WezTerm on Windows: Kitty images need a build whose ConPTY passes them through", () => {
	afterEach(() => {
		setCapabilityOverrides({});
		resetCapabilitiesCache();
	});

	it("falls back to the placeholder with an update hint on a build older than the first good one", () => {
		for (const version of [OLD_STABLE, LAST_BAD]) {
			const caps = detectOn("win32", wezterm(version));
			assert.strictEqual(caps.images, null, version);
			assert.strictEqual(caps.imageHint, WEZTERM_WINDOWS_IMAGES_HINT);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.trueColor, true);
		}
	});

	for (const [name, version] of [
		["the first good build", FIRST_GOOD],
		["a newer nightly", NIGHTLY],
		["a missing version", undefined],
		["a malformed version", "nightly"],
		["an empty version", ""],
	] as const) {
		it(`keeps Kitty images for ${name}`, () => {
			const caps = detectOn("win32", wezterm(version));
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imageHint, undefined);
		});
	}

	it("keeps Kitty images for an old WezTerm outside Windows", () => {
		for (const platform of ["linux", "darwin"] as const) {
			assert.strictEqual(detectOn(platform, wezterm(OLD_STABLE)).images, "kitty");
		}
	});

	it("applies the same rule in the env-injected detection path", () => {
		assert.strictEqual(detectTerminalCapabilities(wezterm(OLD_STABLE), "win32").images, null);
		assert.strictEqual(
			detectTerminalCapabilities(wezterm(OLD_STABLE), "win32").imageHint,
			WEZTERM_WINDOWS_IMAGES_HINT,
		);
		assert.strictEqual(detectTerminalCapabilities(wezterm(NIGHTLY), "win32").images, "kitty");
		assert.strictEqual(detectTerminalCapabilities(wezterm(OLD_STABLE), "linux").images, "kitty");
	});

	for (const [protocol, images] of [
		["kitty", "kitty"],
		["none", null],
	] as const) {
		it(`PI_IMAGE_PROTOCOL=${protocol} wins and drops the update hint`, () => {
			const caps = detectOn("win32", { ...wezterm(OLD_STABLE), PI_IMAGE_PROTOCOL: protocol });
			assert.strictEqual(caps.images, images);
			assert.strictEqual(caps.imageHint, undefined);
		});

		it(`an images=${String(images)} setting wins and drops the update hint`, () => {
			const caps = onPlatform("win32", wezterm(OLD_STABLE), () => {
				setCapabilityOverrides({ images });
				return { ...getCapabilities(), fallback: imageFallback("image/png") };
			});
			assert.strictEqual(caps.images, images);
			assert.strictEqual(caps.imageHint, undefined);
			assert.strictEqual(caps.fallback, "[Image: [image/png]]");
		});
	}

	it("an imageHint-only override change takes effect", () => {
		const hint = onPlatform("linux", {}, () => {
			setCapabilityOverrides({});
			setCapabilityOverrides({ imageHint: "custom hint" });
			return getCapabilities().imageHint;
		});
		assert.strictEqual(hint, "custom hint");
	});

	it("shows the hint through real detection, not only injected capabilities", () => {
		const fallback = onPlatform("win32", wezterm(OLD_STABLE), () => imageFallback("image/png"));
		assert.strictEqual(fallback, `[Image: [image/png]] (${WEZTERM_WINDOWS_IMAGES_HINT})`);
	});

	it("appends the hint to the image placeholder text", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false, imageHint: WEZTERM_WINDOWS_IMAGES_HINT });
		assert.strictEqual(
			imageFallback("image/png", { widthPx: 800, heightPx: 600 }),
			`[Image: [image/png] 800x600] (${WEZTERM_WINDOWS_IMAGES_HINT})`,
		);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		assert.strictEqual(imageFallback("image/png", { widthPx: 800, heightPx: 600 }), "[Image: [image/png] 800x600]");
	});
});
