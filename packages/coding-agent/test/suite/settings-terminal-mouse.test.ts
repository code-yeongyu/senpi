import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

it.each(["off", "whilePending", "always"])(
	"round-trips terminal.mouse=%s without changing the default renderer (#1645)",
	async (mouse) => {
		const root = mkdtempSync(join(tmpdir(), "terminal-mouse-"));
		const agent = join(root, "agent");
		mkdirSync(agent);
		try {
			const manager = SettingsManager.create(root, agent);
			const api = manager as unknown as {
				getTerminalMouse?: () => string;
				setTerminalMouse?: (value: string) => void;
			};
			expect(api.getTerminalMouse?.()).toBe("whilePending");
			expect(api.setTerminalMouse).toBeTypeOf("function");
			api.setTerminalMouse!(mouse);
			await manager.flush();
			expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).terminal.mouse).toBe(mouse);
			const reloaded = SettingsManager.create(root, agent) as unknown as {
				getTerminalMouse(): string;
				getTuiMode(): string;
			};
			expect(reloaded.getTerminalMouse()).toBe(mouse);
			expect(reloaded.getTuiMode()).toBe("regular");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
it("rejects unknown setting strings at the setter and uses the safe default for malformed persisted values", () => {
	const root = mkdtempSync(join(tmpdir(), "terminal-mouse-invalid-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	try {
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ terminal: { mouse: "sometimes" } }));
		const manager = SettingsManager.create(root, agent) as unknown as {
			getTerminalMouse?: () => string;
			setTerminalMouse?: (value: string) => void;
		};
		expect(manager.getTerminalMouse?.()).toBe("whilePending");
		expect(() => manager.setTerminalMouse!("sometimes")).toThrow("Invalid terminal.mouse");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
