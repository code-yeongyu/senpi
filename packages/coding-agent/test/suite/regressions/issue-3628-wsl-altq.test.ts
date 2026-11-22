import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useWindowsKeybindings } from "../../../src/core/keybindings.ts";
import { isWSL } from "../../../src/utils/wsl.ts";

// #3628: Alt+Q (dequeue) must keep Windows defaults on WSL even when the
// launcher environment carries no WSL markers (env-only detection fell back
// to alt+up, so Alt+Q fired nothing).
describe("#3628 WSL detection without environment markers", () => {
	let dir: string;
	let microsoftVersion: string;
	let plainLinuxVersion: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3628-wsl-"));
		microsoftVersion = join(dir, "microsoft-version");
		plainLinuxVersion = join(dir, "plain-linux-version");
		writeFileSync(
			microsoftVersion,
			"Linux version 5.15.167.4-microsoft-standard-WSL2 (root@x86_64) #1 SMP x86_64 GNU/Linux\n",
		);
		writeFileSync(
			plainLinuxVersion,
			"Linux version 6.8.0-45-generic (buildd@lcy02-amd64) #45-Ubuntu SMP x86_64 GNU/Linux\n",
		);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("isWSL", () => {
		it("detects WSL through WSL_DISTRO_NAME", () => {
			expect(isWSL({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		});

		it("detects WSL through WSL_INTEROP alone", () => {
			expect(isWSL({ WSL_INTEROP: "/run/WSL/123_interop" })).toBe(true);
		});

		it("detects WSL through WSLENV alone", () => {
			expect(isWSL({ WSLENV: "WT_SESSION" })).toBe(true);
		});

		it("falls back to /proc/version when the environment carries no WSL markers", () => {
			expect(isWSL({}, microsoftVersion)).toBe(true);
		});

		it("stays false for a plain Linux kernel version", () => {
			expect(isWSL({}, plainLinuxVersion)).toBe(false);
		});

		it("stays false when the kernel version file is unreadable", () => {
			expect(isWSL({}, join(dir, "missing-file"))).toBe(false);
		});
	});

	describe("useWindowsKeybindings", () => {
		it("uses Windows keybindings on WSL when the environment carries no WSL markers", () => {
			expect(useWindowsKeybindings("linux", {}, microsoftVersion)).toBe(true);
		});

		it("uses Windows keybindings when only WSLENV is set", () => {
			expect(useWindowsKeybindings("linux", { WSLENV: "WT_SESSION" })).toBe(true);
		});

		it("keeps non-Windows Linux defaults for a plain Linux kernel version", () => {
			expect(useWindowsKeybindings("linux", {}, plainLinuxVersion)).toBe(false);
		});
	});
});
