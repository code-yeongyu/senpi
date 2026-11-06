export interface KernelPowerThrottling {
	OpenProcess(access: number, inherit: number, pid: number): unknown;
	SetProcessInformation(handle: unknown, infoClass: number, info: Uint8Array, length: number): number;
	CloseHandle(handle: unknown): number;
}

export type KernelPowerThrottlingInstall =
	| { status: "skipped"; reason: "not-windows" | "opted-out" | "no-ffi" }
	| { status: "installed"; self: boolean; restore(): void };

export function loadKernel32PowerThrottling(platform?: NodeJS.Platform): KernelPowerThrottling | undefined;
export function disableExecutionSpeedThrottling(kernel: KernelPowerThrottling, pid: number): boolean;
export function installKernelPowerThrottlingOptOut(options?: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pid?: number;
	load?: (platform: NodeJS.Platform) => KernelPowerThrottling | undefined;
	childProcessPrototype?: { spawn(...args: unknown[]): unknown; pid?: number };
	bun?: { spawn(...args: unknown[]): { pid?: number } };
}): KernelPowerThrottlingInstall;
