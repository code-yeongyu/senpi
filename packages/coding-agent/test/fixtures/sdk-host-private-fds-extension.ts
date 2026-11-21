// senpi#6771 fixture extension: records what the environment held when its module evaluated.
Reflect.set(globalThis, Symbol.for("senpi.test.6771.seen-table"), process.env.SENPI_PRIVATE_FDS ?? null);

export default function sdkHostPrivateFdsExtension(): void {}
