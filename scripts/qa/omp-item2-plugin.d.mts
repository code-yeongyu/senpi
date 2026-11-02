export function runInstalledPlugin(outDir: string): Promise<{
	readonly aggregateVerified: boolean;
	readonly producerSha: string;
	readonly blocked?: unknown;
	readonly [key: string]: unknown;
}>;
