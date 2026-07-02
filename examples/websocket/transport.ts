import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
	WaycastClientTransport,
	WaycastServerTransport,
} from "../../src/index.ts";

export function createWebSocketServerTransport<Context>(
	port: number,
	createContext: (req: IncomingMessage) => Context | Promise<Context>,
): WaycastServerTransport<Context> {
	const wss = new WebSocketServer({ port });
	const connections = new Map<string, WebSocket>();

	return {
		start({ onConnection, onMessage, onDisconnection }) {
			wss.on("connection", async (ws, req) => {
				const connectionId = crypto.randomUUID();
				connections.set(connectionId, ws);

				let context: Context;
				try {
					context = await createContext(req);
				} catch {
					connections.delete(connectionId);
					ws.close();
					return; // onConnection never fires — Waycast never sees this connection
				}

				onConnection(connectionId, context);
				ws.on("message", (raw) => onMessage(connectionId, raw.toString()));
				ws.on("close", () => {
					connections.delete(connectionId);
					onDisconnection(connectionId);
				});
			});
		},
		send(connectionId, raw) {
			connections.get(connectionId)?.send(raw);
		},
		disconnect(connectionId) {
			connections.get(connectionId)?.close();
		},
		stop() {
			return new Promise((resolve, reject) =>
				wss.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}

export function createWebSocketClientTransport(
	url: string,
): WaycastClientTransport {
	let ws: WebSocket;
	return {
		connect({ onOpen, onMessage, onClose }) {
			ws = new WebSocket(url);
			ws.onopen = () => onOpen();
			ws.onmessage = (event) => onMessage(event.data.toString());
			ws.onclose = () => onClose();
		},
		send(raw) {
			ws.send(raw);
		},
		disconnect() {
			ws.close();
		},
	};
}
