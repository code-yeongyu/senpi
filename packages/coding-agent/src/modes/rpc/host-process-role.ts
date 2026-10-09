let hostGenerationScopes = 0;

export function isHostGenerationProcess(): boolean {
	return hostGenerationScopes > 0;
}

export async function runAsHostGenerationProcess<T>(action: () => Promise<T>): Promise<T> {
	hostGenerationScopes += 1;
	try {
		return await action();
	} finally {
		hostGenerationScopes -= 1;
	}
}
