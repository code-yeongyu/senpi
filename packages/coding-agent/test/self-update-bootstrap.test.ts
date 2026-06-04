import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "../src/config.ts";
import { handleBootstrapSelfUpdate, type SelfUpdateBootstrapCommand } from "../src/self-update-bootstrap.ts";

describe("self-update bootstrap", () => {
	it("runs self-update for the default update command before the full CLI loads", async () => {
		// Given
		const writes: string[] = [];
		const commands: SelfUpdateBootstrapCommand[] = [];
		const command: SelfUpdateBootstrapCommand = {
			command: "npm",
			args: ["install", "-g", "@code-yeongyu/senpi"],
			display: "npm install -g @code-yeongyu/senpi",
		};

		// When
		const handled = await handleBootstrapSelfUpdate(["update"], {
			getLatestRelease: async () => ({ version: "9999.0.0" }),
			getSelfUpdateCommand: () => command,
			runCommand: async (step) => {
				commands.push(step);
			},
			writeStdout: (line) => writes.push(line),
			writeStderr: (line) => writes.push(line),
		});

		// Then
		expect(handled).toBe(true);
		expect(commands).toEqual([command]);
		expect(writes.join("\n")).toContain("Updating senpi with npm install -g @code-yeongyu/senpi");
		expect(writes.join("\n")).toContain("Updated senpi");
	});

	it("leaves extension-only update commands for the full CLI", async () => {
		// Given
		const commands: SelfUpdateBootstrapCommand[] = [];

		// When
		const handled = await handleBootstrapSelfUpdate(["update", "--extensions"], {
			getLatestRelease: async () => ({ version: "9999.0.0" }),
			getSelfUpdateCommand: () => ({
				command: "npm",
				args: ["install", "-g", "@code-yeongyu/senpi"],
				display: "npm install -g @code-yeongyu/senpi",
			}),
			runCommand: async (step) => {
				commands.push(step);
			},
		});

		// Then
		expect(handled).toBe(false);
		expect(commands).toEqual([]);
	});

	it("does not reinstall when the registry version matches the current package", async () => {
		// Given
		const writes: string[] = [];
		const commands: SelfUpdateBootstrapCommand[] = [];

		// When
		const handled = await handleBootstrapSelfUpdate(["update", "--self"], {
			getLatestRelease: async () => ({ packageName: PACKAGE_NAME, version: VERSION }),
			getSelfUpdateCommand: () => ({
				command: "npm",
				args: ["install", "-g", "@code-yeongyu/senpi"],
				display: "npm install -g @code-yeongyu/senpi",
			}),
			runCommand: async (step) => {
				commands.push(step);
			},
			writeStdout: (line) => writes.push(line),
		});

		// Then
		expect(handled).toBe(true);
		expect(commands).toEqual([]);
		expect(writes.join("\n")).toContain(`senpi is already up to date (v${VERSION})`);
	});
});
