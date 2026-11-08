import { Console } from "node:console";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { installConsoleRedactor, runSealed, sealedWindowCount } from "../../src/core/egress/console-redactor.ts";
import { createRedactor, REDACTED } from "../../src/core/egress/redact.ts";
import { syntheticSecret } from "./synthetic-secret.ts";

type Method = "log" | "info" | "warn" | "error" | "debug";

function captureConsole(): { target: Record<Method, (...args: unknown[]) => void>; lines: string[] } {
	const lines: string[] = [];
	const sink = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return { target: { log: sink, info: sink, warn: sink, error: sink, debug: sink }, lines };
}

const SECRET_A = `tenantA-${syntheticSecret(3, 12)}`;
const SECRET_B = `tenantB-${syntheticSecret(4, 12)}`;

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

describe("console redactor covers every console method", () => {
	// Every method Node's console writes through, plus one no runtime defines: the wrapper must not need a list.
	const WRITING_METHODS = [
		"log",
		"info",
		"warn",
		"error",
		"debug",
		"dir",
		"dirxml",
		"table",
		"trace",
		"group",
		"groupCollapsed",
		"count",
		"countReset",
		"time",
		"timeEnd",
		"timeLog",
		"customPrint",
	] as const;

	function fullConsole() {
		const lines: string[] = [];
		const conditions: unknown[] = [];
		const sink = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		const target: Record<(typeof WRITING_METHODS)[number], (...args: unknown[]) => void> & {
			assert: (condition: unknown, ...rest: unknown[]) => void;
		} = {
			...(Object.fromEntries(WRITING_METHODS.map((method) => [method, sink])) as Record<
				(typeof WRITING_METHODS)[number],
				(...args: unknown[]) => void
			>),
			assert: (condition: unknown, ...rest: unknown[]) => {
				conditions.push(condition);
				if (!condition) sink(...rest);
			},
		};
		return { target, lines, conditions };
	}

	it.each(WRITING_METHODS)("redacts console.%s inside a sealed context", async (method) => {
		const { target, lines } = fullConsole();
		installConsoleRedactor(target);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			target[method](`value ${SECRET_A}`, { nested: SECRET_A });
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(SECRET_A);
		expect(lines[0]).toContain(REDACTED);
	});

	it.each(WRITING_METHODS)("drops an out-of-context console.%s while a sealed window is open", async (method) => {
		const { target, lines } = fullConsole();
		installConsoleRedactor(target);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sealed = runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), () => held);
		queueMicrotask(() => target[method](`leak ${SECRET_A}`));
		await Promise.resolve();
		release();
		await sealed;
		expect(lines).toEqual([]);
	});

	it("drops an out-of-context console.assert while a sealed window is open", async () => {
		const { target, lines } = fullConsole();
		installConsoleRedactor(target);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sealed = runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), () => held);
		queueMicrotask(() => target.assert(false, `leak ${SECRET_A}`));
		await Promise.resolve();
		release();
		await sealed;
		expect(lines).toEqual([]);
	});

	it("keeps console.assert's condition and redacts its message", async () => {
		const { target, lines, conditions } = fullConsole();
		installConsoleRedactor(target);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			target.assert(true, `fine ${SECRET_A}`);
			target.assert(false, `failed ${SECRET_A}`);
		});
		expect(conditions).toEqual([true, false]);
		expect(lines).toEqual([`failed ${REDACTED}`]);
	});
});

describe("console redactor on a real Node console", () => {
	function captureStream() {
		const chunks: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(String(chunk));
				callback();
			},
		});
		return { stream, text: () => chunks.join("") };
	}

	it("redacts a real Console's writes and leaves its stream error handling alone", async () => {
		const { stream, text } = captureStream();
		const real = new Console({ stdout: stream, stderr: stream });
		const internals = real as unknown as Record<string, unknown>;
		const stdoutHandler = internals._stdoutErrorHandler;
		const listenersBefore = stream.listenerCount("error");
		installConsoleRedactor(real);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			real.log(`key ${SECRET_A}`);
			real.dir({ key: SECRET_A });
			real.table([SECRET_A]);
			real.error(SECRET_A);
		});
		expect(text()).not.toContain(SECRET_A);
		expect(text()).toContain(REDACTED);
		expect(internals._stdoutErrorHandler).toBe(stdoutHandler);
		expect(stream.listenerCount("error")).toBe(listenersBefore);
	});

	it("keeps constructors and non-writing members of the global console untouched", () => {
		const untouched = {
			Console,
			context: () => "context",
			createTask: () => "task",
			profile: () => "profile",
			profileEnd: () => "profileEnd",
			timeStamp: () => "timeStamp",
			takeHeapSnapshot: () => "snapshot",
			_stdoutErrorHandler: () => "handler",
		};
		const target = { ...untouched, log: () => {} };
		installConsoleRedactor(target);
		for (const [name, value] of Object.entries(untouched))
			expect(target[name as keyof typeof untouched], name).toBe(value);
		const { stream } = captureStream();
		expect(new target.Console({ stdout: stream })).toBeInstanceOf(Console);
	});

	it("still wraps a writing method it has never heard of, such as Bun's console.write", async () => {
		const lines: string[] = [];
		const target = { write: (...args: unknown[]) => lines.push(args.map(String).join(" ")) };
		installConsoleRedactor(target);
		await runSealed(createRedactor({ secrets: [SECRET_A], publicPrefixes: [] }), async () => {
			target.write(SECRET_A);
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
