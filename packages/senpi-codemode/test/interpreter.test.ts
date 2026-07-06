import { describe, expect, it } from "vitest";
import type { ExecFileProbe } from "../src/interpreters/detect.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";

function stubProbe(outputs: ReadonlyMap<string, string | Error>): ExecFileProbe {
	return async (command, args, options) => {
		expect(args.at(-1)).toBe("--version");
		expect(options.timeoutMs).toBe(3000);
		const key = [command, ...args].join(" ");
		const value = outputs.get(key);
		if (value instanceof Error) {
			throw value;
		}
		if (typeof value === "string") {
			return { stdout: value, stderr: "" };
		}
		throw new Error("missing command");
	};
}

describe("interpreter detection", () => {
	it("falls through per-platform candidates and rejects empty Store-alias output", async () => {
		const detector = createInterpreterDetector({
			platform: "win32",
			execFile: stubProbe(
				new Map([
					["python --version", ""],
					["py -3 --version", "Python 3.12.4"],
				]),
			),
		});

		await expect(detector.detect("py")).resolves.toEqual({ ok: true, path: "py -3", version: "3.12.4" });
	});

	it("returns unavailable for missing and timed-out interpreters without throwing", async () => {
		const detector = createInterpreterDetector({
			platform: "linux",
			execFile: stubProbe(
				new Map([
					["ruby --version", new Error("ENOENT")],
					["julia --version", new Error("timed out")],
				]),
			),
		});

		await expect(detector.detect("rb")).resolves.toEqual({ ok: false });
		await expect(detector.detect("jl")).resolves.toEqual({ ok: false });
	});

	it("caches detection results per detector instance", async () => {
		let probes = 0;
		const detector = createInterpreterDetector({
			platform: "linux",
			execFile: async () => {
				probes += 1;
				return { stdout: "Python 3.11.9", stderr: "" };
			},
		});

		await expect(detector.detect("py")).resolves.toEqual({ ok: true, path: "python3", version: "3.11.9" });
		await expect(detector.detect("py")).resolves.toEqual({ ok: true, path: "python3", version: "3.11.9" });
		expect(probes).toBe(1);
	});

	it("represents default py/js enabled behavior while missing rb/jl stay unavailable", async () => {
		const detector = createInterpreterDetector({
			platform: "linux",
			execFile: stubProbe(
				new Map<string, string | Error>([
					["python3 --version", "Python 3.10.1"] as const,
					["ruby --version", new Error("ENOENT")] as const,
					["julia --version", new Error("ENOENT")] as const,
				]),
			),
			nodeVersion: "24.1.0",
		});

		const availability = await getInterpreterAvailability(
			{ languages: { py: true, js: true, rb: false, jl: false }, cellTimeoutSeconds: 30, parallelPoolWidth: 4 },
			detector,
		);

		expect(availability).toEqual({
			py: { enabled: true, detected: { ok: true, path: "python3", version: "3.10.1" } },
			js: { enabled: true, detected: { ok: true, path: "node", version: "24.1.0" } },
			rb: { enabled: false, detected: { ok: false } },
			jl: { enabled: false, detected: { ok: false } },
		});
	});
});
