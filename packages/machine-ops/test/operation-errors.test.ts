import { describe, expect, it } from "vitest";
import { MachineOpError, opErrorCode } from "../src/errors.ts";

describe("operation error classification", () => {
	it("preserves an operation error and its cause", () => {
		const cause = new Error("failure");
		const error = new MachineOpError("permission_denied", "denied", { cause });
		expect(opErrorCode(error)).toBe("permission_denied");
		expect(error.cause).toBe(cause);
	});
	it("classifies a default AbortController reason as cancellation", () => {
		const controller = new AbortController();
		controller.abort();
		expect(opErrorCode(controller.signal.reason)).toBe("aborted");
	});
	it.each([
		["ENOENT", "not_found"],
		["ENOTDIR", "not_found"],
		["EACCES", "permission_denied"],
		["EPERM", "permission_denied"],
		["ABORT_ERR", "aborted"],
		["EIO", "io_error"],
	])("classifies errno %s", (code, expected) => {
		expect(opErrorCode(Object.assign(new Error(code), { code }))).toBe(expected);
	});
	it.each([null, undefined, "failure", 20, { code: 20 }, new Error("failure")])(
		"classifies unstructured failures as I/O errors",
		(error) => expect(opErrorCode(error)).toBe("io_error"),
	);
});
