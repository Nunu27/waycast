export interface WaycastServerTransport<Context = unknown> {
	start(handlers: {
		// context is fully resolved by the transport (from headers, auth, etc.) before this fires
		onConnection: (connectionId: string, context: Context) => void;
		onMessage: (connectionId: string, raw: string) => void;
		onDisconnection: (connectionId: string) => void;
	}): void | Promise<void>;

	send(connectionId: string, raw: string): void;
	disconnect(connectionId: string): void; // force-close; used on handshake fingerprint mismatch

	stop(): void | Promise<void>;
}

export interface WaycastClientTransport {
	connect(handlers: {
		onOpen: () => void;
		onMessage: (raw: string) => void;
		onClose: () => void;
	}): void | Promise<void>;

	send(raw: string): void;

	disconnect(): void;
}
