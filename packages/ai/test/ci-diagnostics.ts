function dumpActiveResources(signal: string): void {
	if (!process.env.CI && !process.env.GITHUB_ACTIONS) return;
	console.error(`[pi-ai vitest diagnostics] ${signal} active resources:`, process.getActiveResourcesInfo());
}

process.on("beforeExit", () => dumpActiveResources("beforeExit"));
process.on("SIGTERM", () => dumpActiveResources("SIGTERM"));
