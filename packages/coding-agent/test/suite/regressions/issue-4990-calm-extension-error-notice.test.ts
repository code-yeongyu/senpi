// senpi#4990: an extension handler failure reaches the TUI as a calm notice, never as a crash dump.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDebugLogPath } from "../../../src/config.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../../../src/core/extensions/loader.ts";
import type { NoticeSpec } from "../../../src/core/extensions/notice/index.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";

const CODED_EXTENSION = `
export default function (pi) {
	pi.on("context", async () => {
		const error = new Error(
			"COMPUTER_LAUNCH_CONTEXT_REQUIRED: Computer use cannot start safely from this host's current macOS launch context.",
		);
		error.userFacing = {
			code: "COMPUTER_LAUNCH_CONTEXT_REQUIRED",
			message: "Computer use cannot start safely from this host's current macOS launch context.",
			action: "Restart this host from a local terminal and keep that terminal app running, or use the desktop app (Settings > Restart engine).",
		};
		throw error;
	});
}
`;

function uncodedExtension(statePath: string): string {
	return `
export default function (pi) {
	pi.on("context", async () => {
		throw new Error("could not read " + ${JSON.stringify(statePath)} + "\\nsecond line of detail");
	});
}
`;
}

type NoticeFixture = {
	chatContainer: Container;
	toolOutputExpanded: boolean;
	ui: { requestRender: () => void };
	showNoticeBox: (spec: NoticeSpec) => void;
};

function stripSgr(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderExtensionError(error: ExtensionError): string {
	const fixture: NoticeFixture = {
		chatContainer: new Container(),
		toolOutputExpanded: false,
		ui: { requestRender: vi.fn() },
		showNoticeBox(spec) {
			InteractiveMode.prototype.showNoticeBox.call(fixture, spec);
		},
	};
	Reflect.apply(Reflect.get(InteractiveMode.prototype, "showExtensionError"), fixture, [error]);
	return fixture.chatContainer.children
		.flatMap((child) => child.render(160))
		.map((line) => stripSgr(line).trimEnd())
		.filter((line) => line.trim().length > 0)
		.join("\n");
}

describe("senpi#4990 calm extension error notices", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		initTheme("dark");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-4990-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function captureContextError(fileName: string, source: string): Promise<ExtensionError> {
		fs.writeFileSync(path.join(extensionsDir, fileName), source);
		const loaded = await discoverAndLoadExtensions([], tempDir, tempDir);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir,
			SessionManager.inMemory(),
			registry,
		);
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		await runner.emitContext([]);
		expect(errors).toHaveLength(1);
		const [error] = errors;
		if (error === undefined) throw new Error("missing extension error");
		return error;
	}

	function expectNoCrashDump(rendered: string): void {
		expect(rendered).not.toContain(tempDir);
		expect(rendered).not.toMatch(/^\s*at\s/m);
		expect(rendered).not.toContain("senpi-extension:");
		expect(rendered).not.toContain('Extension "');
	}

	it("shows a coded failure as what happened and what to do", async () => {
		const error = await captureContextError("computer.ts", CODED_EXTENSION);
		expect(error.stack).toMatch(/\n\s+at /);

		const rendered = renderExtensionError(error);

		expectNoCrashDump(rendered);
		expect(rendered).not.toContain("COMPUTER_LAUNCH_CONTEXT_REQUIRED: Computer use");
		expect(rendered).toMatchInlineSnapshot(`
			" Computer use cannot start safely from this host's current macOS launch context.
			 Restart this host from a local terminal and keep that terminal app running, or use the desktop app (Settings > Restart engine).
			 computer · COMPUTER_LAUNCH_CONTEXT_REQUIRED"
		`);
	});

	it("shows an uncoded failure as a calm notice with a one-line reason and the log location", async () => {
		const statePath = path.join(tempDir, "state", "cache.json");
		const error = await captureContextError("flaky-ext.ts", uncodedExtension(statePath));

		const rendered = renderExtensionError(error);

		expectNoCrashDump(rendered);
		expect(rendered).toContain("Something went wrong in flaky-ext");
		expect(rendered).toContain("could not read cache.json");
		expect(rendered).not.toContain("second line of detail");
		expect(rendered).toContain("Details:");
		expect(rendered).toContain(path.basename(getDebugLogPath()));
	});

	it("writes the stack to the debug log instead of the screen", async () => {
		const statePath = path.join(tempDir, "state", "cache.json");
		await captureContextError("flaky-ext.ts", uncodedExtension(statePath));

		const log = fs.readFileSync(getDebugLogPath(), "utf8");
		expect(log).toContain("flaky-ext");
		expect(log).toContain("could not read");
		expect(log).toMatch(/\n\s+at /);
	});
});
