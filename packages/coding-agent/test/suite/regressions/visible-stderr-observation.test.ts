import { afterEach, describe, expect, test, vi } from "vitest";
import { observeVisibleStderrWrites, restoreStderr, takeOverStderr } from "../../../src/core/output-guard.ts";

const releases: Array<() => void> = [];

afterEach(() => {
	for (const release of releases.splice(0).reverse()) release();
	restoreStderr();
	vi.restoreAllMocks();
});

describe.each([true, false])("visible stderr observation, guard first=%s", (guardFirst) => {
	test.each([true, false])("restores writer ownership, observer released first=%s", (releaseFirst) => {
		const writes: string[] = [];
		const sink = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});
		const hidden: string[] = [];
		const notify = vi.fn();
		if (guardFirst) takeOverStderr((text) => hidden.push(text));
		const release = observeVisibleStderrWrites(notify);
		releases.push(release);
		if (!guardFirst) takeOverStderr((text) => hidden.push(text));

		process.stderr.write("hidden diagnostic");
		expect(hidden).toEqual(["hidden diagnostic"]);
		expect(writes).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
		if (releaseFirst) {
			release();
			process.stderr.write("still hidden during quit drain");
			expect(hidden).toHaveLength(2);
			expect(writes).toEqual([]);
			restoreStderr();
		} else {
			restoreStderr();
			process.stderr.write("visible after guard restoration");
			expect(notify).toHaveBeenCalledTimes(1);
			release();
		}
		expect(process.stderr.write).toBe(sink);
		notify.mockClear();
		process.stderr.write("visible after release");
		expect(writes.at(-1)).toBe("visible after release");
		expect(notify).not.toHaveBeenCalled();

		const nextRelease = observeVisibleStderrWrites(notify);
		releases.push(nextRelease);
		process.stderr.write("next renderer");
		expect(notify).toHaveBeenCalledTimes(1);
		nextRelease();
		expect(process.stderr.write).toBe(sink);
	});
});

test("keeps identical listeners independently subscribed and releases idempotently", () => {
	const sink = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const notify = vi.fn();
	const first = observeVisibleStderrWrites(notify);
	const second = observeVisibleStderrWrites(notify);
	releases.push(first, second);
	process.stderr.write("both");
	expect(notify).toHaveBeenCalledTimes(2);
	first();
	first();
	process.stderr.write("second only");
	expect(notify).toHaveBeenCalledTimes(3);
	second();
	expect(process.stderr.write).toBe(sink);
});

test("preserves the visible writer receiver, arguments, callback and backpressure", () => {
	const callback = vi.fn();
	let receiver: unknown;
	const sink = vi.spyOn(process.stderr, "write").mockImplementation(function (this: NodeJS.WriteStream, ...args) {
		receiver = this;
		const last = args.at(-1);
		if (typeof last === "function") last(null);
		return false;
	});
	const notify = vi.fn();
	releases.push(observeVisibleStderrWrites(notify));
	const chunk = Buffer.from("visible diagnostic");
	expect(process.stderr.write(chunk, "utf8", callback)).toBe(false);
	expect(receiver).toBe(process.stderr);
	expect(sink).toHaveBeenCalledWith(chunk, "utf8", callback);
	expect(callback).toHaveBeenCalledWith(null);
	expect(notify).toHaveBeenCalledTimes(1);
});
