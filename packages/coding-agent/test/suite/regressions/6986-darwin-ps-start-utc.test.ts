import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * senpi#6986 L2: the darwin `ps` reader (Node) must read the start time as UTC. A local-time `lstart` in the repeated
 * hour when daylight saving ends is ambiguous and can land 3600 s away from the kernel stamp the Bun FFI reader
 * returns, so a record written under Bun would not match a check under Node. The parse runs in a child pinned to a
 * zone with that repeated hour, so a local-time parse fails here even on a UTC host.
 */
const moduleUrl = pathToFileURL(
	resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/core/kernel-process-identity.ts"),
).href;

function parseInZone(timeZone: string, line: string): Promise<unknown> {
	const script = `const { parseDarwinPsIdentity } = await import(${JSON.stringify(moduleUrl)});
process.stdout.write(JSON.stringify(parseDarwinPsIdentity(${JSON.stringify(line)}) ?? null));`;
	return new Promise((resolvePromise, reject) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", script],
			{ env: { ...process.env, TZ: timeZone }, encoding: "utf8", timeout: 20_000 },
			(error, stdout) => (error === null ? resolvePromise(JSON.parse(stdout)) : reject(error)),
		);
	});
}

describe("darwin ps start time is read as UTC (#6986)", () => {
	it("a start in the repeated DST hour parses to the same instant in any reader zone", async () => {
		// 2026-11-01 01:30 happens twice in America/New_York; under TZ=UTC ps prints the one true instant.
		const line = "    1 Ss   Sun Nov  1 01:30:07 2026\n";
		const expected = { ppid: 1, startedAtMs: Date.UTC(2026, 10, 1, 1, 30, 7), zombie: false };
		await expect(parseInZone("America/New_York", line)).resolves.toEqual(expected);
		await expect(parseInZone("Asia/Seoul", line)).resolves.toEqual(expected);
	});

	it("a zombie and an unparsable line keep their meaning", async () => {
		await expect(parseInZone("UTC", "  42 Z    Sun Nov  1 01:30:07 2026")).resolves.toMatchObject({
			ppid: 42,
			zombie: true,
		});
		await expect(parseInZone("UTC", "  42 S    not a date")).resolves.toBeNull();
	});
});
