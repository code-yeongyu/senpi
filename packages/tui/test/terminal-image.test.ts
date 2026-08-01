/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import {
	buildKittyPlaceholderRow,
	cropKittyImageLine,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeKitty,
	getCellDimensions,
	getKittyImageMetadata,
	hyperlink,
	imageFallback,
	isImageLine,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TmuxPassthroughState,
	wrapTmuxPassthrough,
} from "../src/terminal-image.ts";
import { visibleWidth } from "../src/utils.ts";

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
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"PI_TUI_TMUX_KITTY_PLACEMENT",
] as const;

const tmuxPassthroughOff = (): TmuxPassthroughState => ({ allowPassthrough: "off", clientTermname: "" });

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks under tmux when the client forwards them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => true, tmuxPassthroughOff);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("disables hyperlinks under tmux when the client does not forward them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => false, tmuxPassthroughOff);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("checks tmux capability when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities(() => true, tmuxPassthroughOff);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);

			const caps2 = detectCapabilities(() => false, tmuxPassthroughOff);
			assert.strictEqual(caps2.hyperlinks, false);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via TERM_PROGRAM", () => {
		withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_SESSION_ID", () => {
		withEnv({ WARP_SESSION_ID: "some-session-id" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_TERMINAL_SESSION_UUID", () => {
		withEnv({ WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("disables images for Warp inside tmux", () => {
		withEnv(
			{
				TERM_PROGRAM: "WarpTerminal",
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TERM: "tmux-256color",
			},
			() => {
				const caps = detectCapabilities(() => true, tmuxPassthroughOff);
				assert.strictEqual(caps.images, null);
				assert.strictEqual(caps.hyperlinks, true);
			},
		);
	});

	it("enables Kitty images under tmux when passthrough is on and the outer terminal supports them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(
				() => true,
				() => ({ allowPassthrough: "on", clientTermname: "xterm-ghostty" }),
			);
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.tmuxPassthrough, true);
			assert.strictEqual(caps.kittyUnicodePlaceholders, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("keeps direct WezTerm placement disabled under tmux", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(
				() => true,
				() => ({ allowPassthrough: "on", clientTermname: "wezterm" }),
			);
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.tmuxPassthrough, undefined);
		});
	});

	it("honors only explicit safe terminal identity overrides", () => {
		withEnv(
			{ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color", PI_TUI_TMUX_KITTY_TERMINAL: "kitty" },
			() => {
				const caps = detectCapabilities(
					() => true,
					() => ({ allowPassthrough: "on", clientTermname: "xterm-256color" }),
				);
				assert.strictEqual(caps.images, "kitty");
				assert.strictEqual(caps.kittyUnicodePlaceholders, true);
			},
		);
		withEnv(
			{ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color", PI_TUI_TMUX_KITTY_TERMINAL: "wezterm" },
			() => {
				const caps = detectCapabilities(
					() => true,
					() => ({ allowPassthrough: "on", clientTermname: "xterm-256color" }),
				);
				assert.strictEqual(caps.images, null);
			},
		);
	});

	it("adopts tmux-reported client cell size for image sizing", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			try {
				const caps = detectCapabilities(
					() => true,
					() => ({
						allowPassthrough: "on",
						clientTermname: "xterm-ghostty",
						cellWidthPx: 11,
						cellHeightPx: 23,
					}),
				);
				assert.strictEqual(caps.images, "kitty");
				assert.deepStrictEqual(getCellDimensions(), { widthPx: 11, heightPx: 23 });
			} finally {
				setCellDimensions({ widthPx: 9, heightPx: 18 });
			}
		});
	});

	it("keeps default cell size when tmux does not report one", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			detectCapabilities(
				() => true,
				() => ({ allowPassthrough: "on", clientTermname: "xterm-ghostty" }),
			);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
		});
	});

	it("enables Kitty images under tmux when passthrough is set to all", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(
				() => false,
				() => ({ allowPassthrough: "all", clientTermname: "xterm-kitty" }),
			);
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.tmuxPassthrough, true);
		});
	});

	it("keeps images disabled under tmux when passthrough is off", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(
				() => true,
				() => ({ allowPassthrough: "off", clientTermname: "xterm-ghostty" }),
			);
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.tmuxPassthrough, undefined);
		});
	});

	it("keeps images disabled under tmux passthrough when the outer terminal is unknown", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(
				() => true,
				() => ({ allowPassthrough: "on", clientTermname: "xterm-256color" }),
			);
			assert.strictEqual(caps.images, null);
		});
	});

	it("does not trust stale environment hints for a generic live tmux client", () => {
		withEnv(
			{
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TERM: "tmux-256color",
				GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
			},
			() => {
				const caps = detectCapabilities(
					() => true,
					() => ({ allowPassthrough: "on", clientTermname: "xterm-256color" }),
				);
				assert.strictEqual(caps.images, null);
				assert.strictEqual(caps.tmuxPassthrough, undefined);
			},
		);
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("does not inherit Windows Terminal truecolor through tmux", () => {
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false, tmuxPassthroughOff);
			assert.strictEqual(caps.trueColor, false);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("trusts explicit truecolor hints through tmux", () => {
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false, tmuxPassthroughOff);
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
			assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("suppresses Kitty replies for delete commands", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
			assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.ok(!result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			assert.ok(result);
			assert.ok(result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("registers metadata and crops a partially visible placement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage(
				"AAAA",
				{ widthPx: 100, heightPx: 100 },
				{ maxWidthCells: 3, imageId: 42, moveCursor: false },
			);
			assert.ok(result);
			assert.deepStrictEqual(getKittyImageMetadata(result.sequence), {
				imageId: 42,
				columns: 3,
				rows: 3,
				widthPx: 100,
				heightPx: 100,
			});
			assert.ok(cropKittyImageLine(result.sequence, 2, 1).includes("y=66,h=34,r=1"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("honors maxHeightCells by reducing rendered width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			assert.ok(result);
			assert.strictEqual(result.rows, 5);
			assert.ok(result.sequence.includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("caps Image component height to a square pixel box by default", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 10 },
				{ widthPx: 10, heightPx: 100 },
			);
			const lines = image.render(12);
			assert.strictEqual(lines.length, 5);
			assert.ok(lines[0].includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("places image sequence on first line with empty padding rows", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			assert.strictEqual(typeof imageId, "number");
			assert.ok(lines[0].startsWith("\x1b_G"));
			assert.ok(lines[0].includes(",C=1,"));
			assert.ok(lines[0].includes(`,i=${imageId}`));
			assert.ok(lines[0].endsWith("\x1b\\"));
			assert.deepStrictEqual(lines.slice(1, lines.length), [""]);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("truncates long image fallback lines to render width", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const longPath = join(
				homedir(),
				"images",
				`${"generated-image-with-a-very-long-absolute-path".repeat(4)}.png`,
			);
			const width = 40;
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` },
				{ filename: longPath },
				{ widthPx: 1280, heightPx: 720 },
			);
			const lines = image.render(width);
			assert.strictEqual(lines.length, 1);
			assert.ok(
				visibleWidth(lines[0]) <= width,
				`fallback line wider than ${width}: visible=${visibleWidth(lines[0])} raw=${JSON.stringify(lines[0])}`,
			);
			assert.ok(lines[0].includes("..."), "expected ellipsis when truncating long fallback path");
			assert.ok(lines[0].includes("~"), "expected home-shortened path in fallback");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("imageFallback", () => {
	it("shortens home-prefixed absolute paths without hyperlinks", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, abs);
			assert.strictEqual(result, "[Image: ~/.pi/agent/shot.png [image/png] 1280x720]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps shortened absolute paths in OSC 8 file links when hyperlinks are enabled", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 10, heightPx: 10 }, abs);
			assert.ok(result.includes("\x1b]8;;file://"), "expected OSC 8 file link");
			assert.ok(
				result.includes(abs.replaceAll("\\", "/")) || result.includes(abs),
				"file URL should target absolute path",
			);
			// Visible text must use ~/... not the expanded home path.
			const visible = result.replace(/\x1b\]8;;.*?\x1b\\/g, "");
			assert.strictEqual(visible, "[Image: ~/.pi/agent/shot.png [image/png] 10x10]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("leaves bare basenames unchanged and does not hyperlink them", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const result = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "clankolas.png");
			assert.strictEqual(result, "[Image: clankolas.png [image/png] 1x1]");
			assert.ok(!result.includes("\x1b]8;"), "basename must not be hyperlinked");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("omits filename segment when not provided", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			assert.strictEqual(imageFallback("image/png", { widthPx: 8, heightPx: 6 }), "[Image: [image/png] 8x6]");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("tmux passthrough", () => {
	const passthroughCaps = {
		images: "kitty",
		trueColor: true,
		hyperlinks: true,
		tmuxPassthrough: true,
	} as const;

	it("wraps a sequence in a tmux DCS envelope and doubles embedded escapes", () => {
		const wrapped = wrapTmuxPassthrough("\x1b_Ga=T;AAAA\x1b\\");
		assert.strictEqual(wrapped, "\x1bPtmux;\x1b\x1b_Ga=T;AAAA\x1b\x1b\\\x1b\\");
	});

	it("wraps single-chunk Kitty sequences when tmux passthrough is active", () => {
		setCapabilities({ ...passthroughCaps });
		try {
			const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 7 });
			assert.ok(sequence.startsWith("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,c=2,r=2,i=7;AAAA"));
			assert.ok(sequence.endsWith("\x1b\x1b\\\x1b\\"));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps every Kitty chunk in its own passthrough envelope", () => {
		setCapabilities({ ...passthroughCaps });
		try {
			const base64Data = "A".repeat(4096 * 2 + 10);
			const sequence = encodeKitty(base64Data, { columns: 2, rows: 2 });
			const envelopes = sequence.split("\x1bPtmux;").filter((part) => part.length > 0);
			assert.strictEqual(envelopes.length, 3);
			for (const envelope of envelopes) {
				assert.ok(envelope.startsWith("\x1b\x1b_G"));
				assert.ok(envelope.endsWith("\x1b\x1b\\\x1b\\"));
			}
			// The unwrapped payload must reassemble into the plain chunked form.
			resetCapabilitiesCache();
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const plain = encodeKitty(base64Data, { columns: 2, rows: 2 });
			const unwrapped = envelopes.map((envelope) => envelope.slice(0, -2).replaceAll("\x1b\x1b", "\x1b")).join("");
			assert.strictEqual(unwrapped, plain);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps Kitty delete commands when tmux passthrough is active", () => {
		setCapabilities({ ...passthroughCaps });
		try {
			assert.strictEqual(deleteKittyImage(42), "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=42,q=2\x1b\x1b\\\x1b\\");
			assert.strictEqual(deleteAllKittyImages(), "\x1bPtmux;\x1b\x1b_Ga=d,d=A,q=2\x1b\x1b\\\x1b\\");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("encodes virtual placements with U=1 instead of cursor placement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 7, virtual: true });
			assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,U=1,c=2,r=2,i=7;"));
			assert.ok(!sequence.includes(",C=1"));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("builds placeholder rows with row/column diacritics and the id in the foreground color", () => {
		const row = buildKittyPlaceholderRow(7, 0, 2);
		const cell = (column: number) =>
			String.fromCodePoint(0x10eeee) + String.fromCodePoint(0x0305) + String.fromCodePoint([0x0305, 0x030d][column]);
		assert.strictEqual(row, `\x1b[38;2;0;0;7m${cell(0)}${cell(1)}\x1b[39m`);
		assert.strictEqual(visibleWidth(row), 2);
	});

	it("adds the id high-byte diacritic for image ids above 24 bits", () => {
		const imageId = 0x02000003;
		const row = buildKittyPlaceholderRow(imageId, 0, 1);
		assert.ok(row.startsWith("\x1b[38;2;0;0;3m"));
		const expectedCell =
			String.fromCodePoint(0x10eeee) +
			String.fromCodePoint(0x0305) +
			String.fromCodePoint(0x0305) +
			String.fromCodePoint(0x030e); // diacritic index 2 carries the high byte
		assert.ok(row.includes(expectedCell));
		assert.strictEqual(visibleWidth(row), 1);
	});

	it("renders placeholder lines when kittyUnicodePlaceholders is active", () => {
		setCapabilities({ ...passthroughCaps, kittyUnicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, imageId: 7 });
			assert.ok(result);
			assert.ok(result.lines);
			assert.strictEqual(result.lines.length, 2);
			assert.strictEqual(result.rows, 2);
			assert.strictEqual(result.imageId, 7);
			// First line carries the wrapped virtual transmission plus placeholders.
			assert.ok(result.lines[0].startsWith("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,U=1,c=2,r=2,i=7;"));
			assert.strictEqual(isImageLine(result.lines[0]), true);
			assert.strictEqual(visibleWidth(result.lines[0]), 2);
			// Subsequent lines are plain placeholder text.
			assert.strictEqual(isImageLine(result.lines[1]), false);
			assert.strictEqual(visibleWidth(result.lines[1]), 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("Image component emits placeholder rows instead of empty padding lines", () => {
		setCapabilities({ ...passthroughCaps, kittyUnicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			assert.strictEqual(lines.length, 2);
			assert.ok(lines[0].startsWith("\x1bPtmux;\x1b\x1b_G"));
			assert.ok(lines[0].includes(`i=${image.getImageId()}`));
			assert.strictEqual(visibleWidth(lines[1]), 2);
			assert.notStrictEqual(lines[1], "");
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("keeps wrapped image lines detectable and invisible to width accounting", () => {
		setCapabilities({ ...passthroughCaps });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			assert.ok(lines[0].startsWith("\x1bPtmux;\x1b\x1b_G"));
			assert.strictEqual(isImageLine(lines[0]), true);
			assert.strictEqual(visibleWidth(lines[0]), 0);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});
