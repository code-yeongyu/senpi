import { afterEach, describe, expect, test, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { classifyRead, type ReadClassifier, registerReadClassifier } from "../../src/core/tools/read-classifiers.ts";
import {
	classifyRead as publicClassifyRead,
	registerReadClassifier as publicRegisterReadClassifier,
} from "../../src/index.ts";

const input = { absolutePath: "/project/memory/preference.md", cwd: "/project" };
const memory = { kind: "memory" as const, label: "preference", headline: "Remembered" };
const unregisters: Array<() => void> = [];

function register(classifier: ReadClassifier): () => void {
	const unregister = registerReadClassifier(classifier);
	unregisters.push(unregister);
	return unregister;
}

afterEach(() => {
	for (const unregister of unregisters.splice(0)) unregister();
});

describe("read classifiers", () => {
	test("public exports share the core registry", () => {
		expect(publicRegisterReadClassifier).toBe(registerReadClassifier);
		expect(publicClassifyRead).toBe(classifyRead);
	});

	test("returns undefined when nothing claims the path", () => {
		expect(classifyRead(input)).toBeUndefined();
		register(() => undefined);
		expect(classifyRead(input)).toBeUndefined();
	});

	test("passes the input through and stops at the first result", () => {
		const decline = vi.fn(() => undefined);
		const claim = vi.fn(() => memory);
		const later = vi.fn(() => ({ kind: "docs" as const, label: "later" }));
		register(decline);
		register(claim);
		register(later);
		expect(classifyRead(input)).toEqual(memory);
		expect(decline).toHaveBeenCalledExactlyOnceWith(input);
		expect(claim).toHaveBeenCalledExactlyOnceWith(input);
		expect(later).not.toHaveBeenCalled();
	});

	test("unregister removes only its own registration and is idempotent", () => {
		const classifier = () => memory;
		const first = register(classifier);
		register(() => undefined);
		const duplicate = register(classifier);
		first();
		first();
		expect(classifyRead(input)).toEqual(memory);
		duplicate();
		expect(classifyRead(input)).toBeUndefined();
	});

	test("skips a throwing classifier", () => {
		register(() => {
			throw new Error("classifier failed");
		});
		expect(classifyRead(input)).toBeUndefined();
		register(() => memory);
		expect(classifyRead(input)).toEqual(memory);
	});
});

describe("extension read classifier registration", () => {
	test("registers during factory loading and removes classifiers on runtime invalidation", async () => {
		const runtime = createExtensionRuntime();
		try {
			await loadExtensionFromFactory(
				(pi) => {
					unregisters.push(pi.registerReadClassifier(() => memory));
				},
				input.cwd,
				createEventBus(),
				runtime,
			);
			expect(classifyRead(input)).toEqual(memory);
			runtime.invalidate();
			expect(classifyRead(input)).toBeUndefined();
		} finally {
			runtime.invalidate();
		}
	});

	test("discards registrations when a factory fails and rejects its stale API", async () => {
		const runtime = createExtensionRuntime();
		let api: ExtensionAPI | undefined;
		try {
			await expect(
				loadExtensionFromFactory(
					(pi) => {
						api = pi;
						unregisters.push(pi.registerReadClassifier(() => memory));
						throw new Error("factory failed");
					},
					input.cwd,
					createEventBus(),
					runtime,
				),
			).rejects.toThrow("factory failed");
			expect(classifyRead(input)).toBeUndefined();
			expect(() => api?.registerReadClassifier(() => memory)).toThrow();
		} finally {
			runtime.invalidate();
		}
	});
});
