import { describe, expect, it } from "vitest";
import { installConsoleRedactor, runSealed, sealedWindowCount } from "../../src/core/egress/console-redactor.ts";
import { createRedactor, REDACTED } from "../../src/core/egress/redact.ts";

type Method = "log" | "info" | "warn" | "error" | "debug";

function captureConsole(): { target: Record<Method, (...args: unknown[]) => void>; lines: string[] } {
	const lines: string[] = [];
	const sink = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return { target: { log: sink, info: sink, warn: sink, error: sink, debug: sink }, lines };
}

const SECRET_A = "tenantA-Zq8xP2vL9mN4";
const SECRET_B = "tenantB-Kc3hW7yR1tJ6";

describe("console redactor", () => {
	it("redacts a line with the patterns of the sealed context it was written in", async () => {
		const { target, lines } = captureConsole();
		installConsoleRedactor(target);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			target.error("request failed with key", SECRET_A);
		});
		expect(lines).toEqual([`request failed with key ${REDACTED}`]);
	});

	it("applies no tenant's patterns to another tenant's lines (console-cross-tenant-redact)", async () => {
		const { target, lines } = captureConsole();
		installConsoleRedactor(target);
		let releaseA: () => void = () => {};
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const tenantA = runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			await gateA;
			target.log(`A sees ${SECRET_A} and ${SECRET_B}`);
		});
		const tenantB = runSealed(createRedactor({ secrets: [SECRET_B], publicPrefixes: [] }), async () => {
			target.log(`B sees ${SECRET_A} and ${SECRET_B}`);
			releaseA();
		});
		await Promise.all([tenantA, tenantB]);
		expect(lines).toEqual([`B sees ${SECRET_A} and ${REDACTED}`, `A sees ${REDACTED} and ${SECRET_B}`]);
	});

	it("drops an out-of-context line while any sealed window is open", async () => {
		const { target, lines } = captureConsole();
		installConsoleRedactor(target);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sealed = runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), () => held);
		expect(sealedWindowCount()).toBe(1);
		queueMicrotask(() => target.warn(`sdk internal ${SECRET_A}`));
		await Promise.resolve();
		release();
		await sealed;
		expect(lines).toEqual([]);
	});

	it("passes an out-of-context line through unchanged when no sealed window is open", () => {
		const { target, lines } = captureConsole();
		installConsoleRedactor(target);
		expect(sealedWindowCount()).toBe(0);
		target.info("plain startup line");
		expect(lines).toEqual(["plain startup line"]);
	});

	it("installs once per console object", async () => {
		const { target, lines } = captureConsole();
		installConsoleRedactor(target);
		installConsoleRedactor(target);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			target.log(SECRET_A);
		});
		expect(lines).toEqual([REDACTED]);
	});
});

describe("sealed window counter (sealed-window-leak, sealed-window-no-finally)", () => {
	it("returns to zero after the sealed work throws", async () => {
		const failing = runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			throw new Error("provider exploded");
		});
		await expect(failing).rejects.toThrow("provider exploded");
		expect(sealedWindowCount()).toBe(0);
	});

	it("returns to zero after the sealed work resolves", async () => {
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => "ok");
		expect(sealedWindowCount()).toBe(0);
	});
});
