export interface WaycastDisposalScheduler {
	// scheduling an already-scheduled key replaces the previous deadline (latest disconnect wins)
	schedule(key: string, delayMs: number): void | Promise<void>;

	// no-op if the key doesn't exist or has already fired
	cancel(key: string): void | Promise<void>;

	onDue(handler: (key: string) => void): void;
}

export function createInMemoryDisposalScheduler(): WaycastDisposalScheduler {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let due: ((key: string) => void) | undefined;

	return {
		schedule(key, delayMs) {
			const existing = timers.get(key);
			if (existing) clearTimeout(existing);
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key);
					due?.(key);
				}, delayMs),
			);
		},
		cancel(key) {
			const existing = timers.get(key);
			if (existing) clearTimeout(existing);
			timers.delete(key);
		},
		onDue(handler) {
			due = handler;
		},
	};
}
