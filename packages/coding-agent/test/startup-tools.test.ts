import { describe, expect, it, vi } from "vitest";
import { resolveStartupToolPaths } from "../src/modes/interactive/startup-tools.js";

describe("startup tool resolution", () => {
	it("uses only already-available fd during interactive startup", () => {
		const getToolPath = vi.fn((tool: "fd" | "rg") => (tool === "fd" ? "/usr/local/bin/fd" : "/usr/local/bin/rg"));

		const paths = resolveStartupToolPaths(getToolPath);

		expect(paths).toEqual({ fdPath: "/usr/local/bin/fd" });
		expect(getToolPath).toHaveBeenCalledExactlyOnceWith("fd");
	});

	it("keeps startup non-blocking when fd is not installed yet", () => {
		const getToolPath = vi.fn(() => null);

		const paths = resolveStartupToolPaths(getToolPath);

		expect(paths).toEqual({ fdPath: undefined });
		expect(getToolPath).toHaveBeenCalledExactlyOnceWith("fd");
	});
});
