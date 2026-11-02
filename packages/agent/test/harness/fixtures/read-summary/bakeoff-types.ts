export type BakeoffOptions = {
	readonly input: string;
	readonly manifestHash: string;
	readonly omp: string;
	readonly out: string;
	readonly baseline?: string;
	readonly gate?: string;
};
