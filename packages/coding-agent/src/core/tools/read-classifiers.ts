export interface CompactReadClassification {
	readonly kind: "docs" | "resource" | "skill" | "memory";
	readonly label: string;
	readonly headline?: string;
}

export type ReadClassifier = (input: {
	readonly absolutePath: string;
	readonly cwd: string;
}) => CompactReadClassification | undefined;

const classifiers: Array<{ classifier: ReadClassifier }> = [];

/** Register a compact read classifier. The returned function removes this registration. */
export function registerReadClassifier(classifier: ReadClassifier): () => void {
	const entry = { classifier };
	classifiers.push(entry);
	return () => {
		const index = classifiers.indexOf(entry);
		if (index !== -1) classifiers.splice(index, 1);
	};
}

/** First registered classifier to claim a path wins; a failed classifier cannot block later ones. */
export function classifyRead(input: { absolutePath: string; cwd: string }): CompactReadClassification | undefined {
	for (const { classifier } of classifiers) {
		try {
			const classification = classifier(input);
			if (classification !== undefined) return classification;
		} catch (error) {
			console.warn("Read classifier failed:", error);
		}
	}
	return undefined;
}
