// In-memory loopback transport pair, used only by this package's own tests to exercise
// the server/client core without any real network I/O. Not part of the public API.
import type { WaycastAdapter } from "./adapter.ts";
import type {
	WaycastClientTransport,
	WaycastServerTransport,
} from "./transport.ts";

// Models a distributed adapter (e.g. Redis) shared by several server instances: each
// linked adapter is its own handle with its own onMessage slot (matching the real
// WaycastAdapter contract, which allows exactly one registration per instance), but a
// publish() on any of them fans out to every handle's handler, including its own —
// the same loopback behavior a real pub/sub backend exhibits.
export function createLinkedInMemoryAdapters(count: number): WaycastAdapter[] {
	const handlers: ((topic: string, raw: string) => void)[] = [];
	return Array.from({ length: count }, () => ({
		subscribe() {},
		unsubscribe() {},
		publish(topic: string, raw: string) {
			for (const handler of handlers) handler(topic, raw);
		},
		onMessage(handler: (topic: string, raw: string) => void) {
			handlers.push(handler);
		},
	}));
}

export interface MemoryClientTransport extends WaycastClientTransport {
	// test-only helper mirroring what a real reconnecting transport (WebSocket/Socket.io)
	// does internally: re-invoke the same onOpen/onMessage/onClose callback set against a
	// fresh connectionId, without Waycast core ever calling `connect()` a second time.
	simulateReconnect(): void;
}

export interface MemoryServerTransport<Context>
	extends WaycastServerTransport<Context> {
	connectClient(context: Context): MemoryClientTransport;
}

export function createMemoryServerTransport<
	Context = undefined,
>(): MemoryServerTransport<Context> {
	type Handlers = Parameters<WaycastServerTransport<Context>["start"]>[0];
	let handlers: Handlers | undefined;
	const sockets = new Map<
		string,
		{ sendToClient: (raw: string) => void; forceClose: () => void }
	>();
	let nextId = 0;

	return {
		start(h) {
			handlers = h;
		},
		send(connectionId, raw) {
			sockets.get(connectionId)?.sendToClient(raw);
		},
		disconnect(connectionId) {
			const socket = sockets.get(connectionId);
			sockets.delete(connectionId);
			socket?.forceClose();
		},
		stop() {},
		connectClient(context) {
			let connectionId = "";
			let clientHandlers:
				| Parameters<WaycastClientTransport["connect"]>[0]
				| undefined;
			let connected = false;

			function open() {
				connectionId = `conn-${++nextId}`;
				connected = true;
				sockets.set(connectionId, {
					sendToClient(raw) {
						if (connected) clientHandlers?.onMessage(raw);
					},
					forceClose() {
						if (!connected) return;
						connected = false;
						clientHandlers?.onClose();
					},
				});
				handlers?.onConnection(connectionId, context);
			}

			return {
				connect(h) {
					clientHandlers = h;
					open();
					h.onOpen();
				},
				send(raw) {
					if (!connected) return;
					handlers?.onMessage(connectionId, raw);
				},
				disconnect() {
					if (!connected) return;
					connected = false;
					sockets.delete(connectionId);
					handlers?.onDisconnection(connectionId);
					clientHandlers?.onClose();
				},
				simulateReconnect() {
					open();
					clientHandlers?.onOpen();
				},
			};
		},
	};
}
