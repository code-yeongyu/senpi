import { describe, expect, it } from "vitest";
import { isCompiledBunBinaryUrl } from "../src/config.ts";

describe("isCompiledBunBinaryUrl", () => {
	it("matches the posix virtual filesystem root of a compiled binary", () => {
		expect(isCompiledBunBinaryUrl("file:///$bunfs/root/pi")).toBe(true);
	});

	it("matches the windows virtual drive, raw and percent-encoded, any drive letter", () => {
		expect(isCompiledBunBinaryUrl("file:///B:/~BUN/root/pi")).toBe(true);
		expect(isCompiledBunBinaryUrl("file:///b:/%7EBUN/root/pi")).toBe(true);
	});

	it("never matches stock bun disk paths that merely contain a marker segment", () => {
		expect(isCompiledBunBinaryUrl("file:///private/tmp/$bunfs-stock-integration/probe.ts")).toBe(false);
		expect(isCompiledBunBinaryUrl("file:///tmp/$bunfs/project/config.ts")).toBe(false);
		expect(isCompiledBunBinaryUrl("file:///Users/dev/~BUN/root/config.ts")).toBe(false);
		expect(isCompiledBunBinaryUrl("file:///Users/dev/%7EBUN/root/config.ts")).toBe(false);
	});

	it("never matches ordinary disk urls", () => {
		expect(isCompiledBunBinaryUrl("file:///Users/dev/senpi/src/config.ts")).toBe(false);
	});
});
