export interface WaycastAdapter {
	subscribe(connectionId: string, topic: string): void | Promise<void>;
	unsubscribe(connectionId: string, topic: string): void | Promise<void>;
	publish(topic: string, raw: string): void | Promise<void>;

	// fires on every publish (local or cluster-wide); a distributed adapter must fan this
	// out to every instance so each can deliver to its own local connections
	onMessage(handler: (topic: string, raw: string) => void): void;
}

export function createInMemoryAdapter(): WaycastAdapter {
	let handler: ((topic: string, raw: string) => void) | undefined;

	return {
		subscribe() {
			// no-op: local membership is tracked by server core, not the adapter
		},
		unsubscribe() {},
		publish(topic, raw) {
			handler?.(topic, raw);
		},
		onMessage(h) {
			handler = h;
		},
	};
}
