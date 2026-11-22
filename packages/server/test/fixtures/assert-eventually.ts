import { setTimeout } from "node:timers/promises";

export async function assertEventually(assertion: () => void): Promise<void> {
	const deadline = performance.now() + 1_000;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw error;
			await setTimeout(Math.min(50, remaining));
		}
	}
}
