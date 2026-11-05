import { spawn } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface ProbeEntry {
	readonly valid: boolean;
	readonly name: string | null;
}

function tagged<T>(report: string, tag: string): T {
	const line = report.split("\n").find((candidate) => candidate.startsWith(`${tag}:`));
	if (line === undefined) throw new Error(`missing ${tag} line in ${report}`);
	return JSON.parse(line.slice(tag.length + 1));
}

// #5267: prove from inside an unrelated child that adopted pair handles never reach it.
describe.skipIf(process.platform !== "win32")("Windows private pair inheritance", () => {
	it("an ordinary child sees an inheritable control but neither adopted handle, and the hop still round-trips", async () => {
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-pair-inherit.ts");
		const child = spawn("bun", [fixture], {
			env: { ...process.env, SENPI_PRIVATE_FDS: '{"a":[5,6]}' },
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) });
		const slots: readonly unknown[] = child.stdio;
		const input = slots[5];
		const output = slots[6];
		if (!(input instanceof Socket) || !(output instanceof Socket)) throw new Error("missing pipes");
		input.on("error", () => input.destroy());
		output.on("error", () => output.destroy());
		let received = "";
		let report = "";
		let errors = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			report += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		output.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		output.resume();
		input.end("ping");
		try {
			expect((await closed)[0], `${errors}\n${report}`).toBe(0);
			const parent = tagged<{ inheritable: (boolean | null)[]; names: (string | null)[] }>(report, "parent");
			const probe = tagged<ProbeEntry[]>(report, "probe");
			console.log(`#5267 parent=${JSON.stringify(parent)} probe=${JSON.stringify(probe)}`);
			// Handle order: [inheritable control duplicate of the first half, first half, second half].
			expect(parent.inheritable).toEqual([true, false, false]);
			expect(parent.names.every((name) => typeof name === "string" && name.length > 0)).toBe(true);
			expect(parent.names[0]).toBe(parent.names[1]);
			const visible = probe.map((entry, index) => entry.valid && entry.name === parent.names[index]);
			expect({ control: visible[0], adopted: visible.slice(1) }).toEqual({ control: true, adopted: [false, false] });
			expect(received).toBe("echo:ping");
			expect(JSON.parse(report.split("\n").at(-1) ?? "")).toEqual({ closed: [true, true] });
		} finally {
			input.destroy();
			output.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	});
});
