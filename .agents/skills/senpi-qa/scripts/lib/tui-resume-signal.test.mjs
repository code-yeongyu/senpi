import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createResumeCleanupController } from "./tui-resume-signal.mjs";

function fixture({ teardownResult = { ptyExited: true } } = {}) {
	const events = [];
	const processLike = new EventEmitter();
	const controller = createResumeCleanupController({
		processLike,
		exit(code) {
			events.push(["exit", code]);
		},
		async teardown() {
			events.push(["teardown"]);
			if (teardownResult instanceof Error) throw teardownResult;
			return teardownResult;
		},
		postExitCleanup(receipt) {
			events.push(["cleanup", receipt.ptyExited]);
			if (receipt.ptyExited) receipt.sandboxRemoved = true;
			return receipt;
		},
		prePtyCleanup() {
			events.push(["pre-pty-cleanup"]);
			return { ptyExited: false, sandboxRemoved: true };
		},
	});
	return { controller, events, processLike };
}

test("SIGTERM awaits confirmed PTY exit before sandbox cleanup and process exit", async () => {
	const { controller, events, processLike } = fixture();
	controller.registerPty({}, {});
	controller.install();
	processLike.emit("SIGTERM");
	await controller.signalCompletion;
	assert.deepEqual(events, [["teardown"], ["cleanup", true], ["exit", 143]]);
});

test("signal cleanup refuses sandbox removal when PTY exit is unconfirmed", async () => {
	const error = new Error("not confirmed");
	error.receipt = { ptyExited: false };
	const { controller, events, processLike } = fixture({ teardownResult: error });
	controller.registerPty({}, {});
	controller.install();
	processLike.emit("SIGINT");
	await controller.signalCompletion;
	assert.deepEqual(events, [["teardown"], ["cleanup", false], ["exit", 130]]);
});

test("normal and signal cleanup share one idempotent teardown", async () => {
	const { controller, events } = fixture();
	controller.registerPty({}, {});
	await Promise.all([controller.cleanup(), controller.cleanup()]);
	assert.deepEqual(events, [["teardown"], ["cleanup", true]]);
});

test("signal before PTY spawn cleans the sandbox without claiming PTY exit", async () => {
	const { controller, events, processLike } = fixture();
	controller.install();
	processLike.emit("SIGINT");
	const receipt = await controller.signalCompletion;
	assert.deepEqual(events, [["pre-pty-cleanup"], ["exit", 130]]);
	assert.equal(receipt, undefined);
});
