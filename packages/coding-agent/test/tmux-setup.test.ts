import { describe, expect, it } from "vitest";
import { buildTmuxSetupWarning } from "../src/modes/interactive/tmux-setup.ts";

describe("buildTmuxSetupWarning", () => {
	it("returns undefined when everything is configured", () => {
		expect(
			buildTmuxSetupWarning({
				extendedKeys: "on",
				extendedKeysFormat: "csi-u",
				imagesEnabled: true,
				outerKittyCapable: true,
			}),
		).toBeUndefined();
	});

	it("collects every missing setting into a single message", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "off",
			extendedKeysFormat: "xterm",
			imagesEnabled: false,
			outerKittyCapable: true,
		});

		expect(warning).toBeDefined();
		expect(warning).toContain("Add to ~/.tmux.conf and restart tmux:");
		expect(warning).toContain("set -g extended-keys on");
		expect(warning).toContain("set -g extended-keys-format csi-u");
		expect(warning).toContain("set -g allow-passthrough on");
		expect(warning).toContain("set -g focus-events on");
	});

	it("accepts extended-keys always", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "always",
			extendedKeysFormat: "csi-u",
			imagesEnabled: true,
			outerKittyCapable: true,
		});
		expect(warning).toBeUndefined();
	});

	it("does not recommend extended-keys when the multiplexer does not register that option", () => {
		// A tmux-compatible multiplexer without the option (psmux 3.4) answers `show -gv extended-keys`
		// with exit 0 and an empty value; real tmux always prints on/off/always.
		const warning = buildTmuxSetupWarning({
			extendedKeys: "",
			extendedKeysFormat: "",
			imagesEnabled: true,
			outerKittyCapable: true,
		});
		expect(warning).toBeUndefined();
	});

	it("only warns about extended-keys-format when it is xterm", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "off",
			extendedKeysFormat: undefined,
			imagesEnabled: true,
			outerKittyCapable: true,
		});
		expect(warning).toContain("set -g extended-keys on");
		expect(warning).not.toContain("extended-keys-format");
	});

	it("does not recommend allow-passthrough when images already work", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "off",
			extendedKeysFormat: "csi-u",
			imagesEnabled: true,
			outerKittyCapable: true,
		});
		expect(warning).toContain("set -g extended-keys on");
		expect(warning).not.toContain("allow-passthrough");
	});

	it("does not recommend allow-passthrough when the outer terminal cannot render Kitty graphics", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "off",
			extendedKeysFormat: "csi-u",
			imagesEnabled: false,
			outerKittyCapable: false,
		});
		expect(warning).toContain("set -g extended-keys on");
		expect(warning).not.toContain("allow-passthrough");
	});

	it("recommends passthrough and focus events when the keyboard is already configured", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "on",
			extendedKeysFormat: "csi-u",
			imagesEnabled: false,
			outerKittyCapable: true,
		});
		expect(warning).toBeDefined();
		expect(warning).toContain("set -g allow-passthrough on");
		expect(warning).toContain("set -g focus-events on");
		expect(warning).not.toContain("extended-keys");
	});

	it("aligns the reason comments across recommendations", () => {
		const warning = buildTmuxSetupWarning({
			extendedKeys: "off",
			extendedKeysFormat: "xterm",
			imagesEnabled: false,
			outerKittyCapable: true,
		});
		const lines = (warning ?? "").split("\n").filter((line) => line.startsWith("  set -g"));
		expect(lines).toHaveLength(4);
		const commentColumns = new Set(lines.map((line) => line.indexOf("#")));
		expect(commentColumns.size).toBe(1);
	});
});
