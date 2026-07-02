import type { Server, Socket } from "socket.io";
import { io as ioClient } from "socket.io-client";
import type {
	WaycastClientTransport,
	WaycastServerTransport,
} from "../../src/index.ts";

export function createSocketIOServerTransport<Context>(
	io: Server,
	createContext: (handshake: Socket["handshake"]) => Context | Promise<Context>,
): WaycastServerTransport<Context> {
	return {
		start({ onConnection, onMessage, onDisconnection }) {
			io.on("connection", async (socket) => {
				let context: Context;
				try {
					context = await createContext(socket.handshake);
				} catch {
					socket.disconnect(true);
					return; // onConnection never fires — Waycast never sees this connection
				}

				onConnection(socket.id, context);
				socket.on("message", (raw) => onMessage(socket.id, raw));
				socket.on("disconnect", () => onDisconnection(socket.id));
			});
		},
		send(connectionId, raw) {
			io.to(connectionId).emit("message", raw);
		},
		disconnect(connectionId) {
			io.sockets.sockets.get(connectionId)?.disconnect(true);
		},
		stop() {
			return new Promise((resolve) => io.close(() => resolve()));
		},
	};
}

export function createSocketIOClientTransport(
	url: string,
): WaycastClientTransport {
	let socket: ReturnType<typeof ioClient>;
	return {
		connect({ onOpen, onMessage, onClose }) {
			socket = ioClient(url);
			socket.on("connect", () => onOpen());
			socket.on("message", (raw) => onMessage(raw));
			socket.on("disconnect", () => onClose());
		},
		send(raw) {
			socket.emit("message", raw);
		},
		disconnect() {
			socket.disconnect();
		},
	};
}
