import type { Codec } from "./codec.ts";
import { jsonCodec } from "./codec.ts";
import {
	type ClientMessage,
	computeRouterFingerprint,
	type ReplyEnvelope,
	replyTopic,
	type ServerMessage,
} from "./protocol.ts";
import { buildRouteName, type ParamsArg } from "./route-name.ts";
import type {
	AnyRoute,
	AnySchema,
	DataRoute,
	InferOutput,
	RouteParams,
	RpcRoute,
	Waycast,
} from "./router.ts";
import type { WaycastClientTransport } from "./transport.ts";

type RpcRouteNames<Routes> = {
	[K in keyof Routes]: Routes[K] extends RpcRoute ? K : never;
}[keyof Routes];
type DataRouteNames<Routes> = {
	[K in keyof Routes]: Routes[K] extends DataRoute ? K : never;
}[keyof Routes];

export type RpcCallbacks<
	Replies extends Record<string, AnySchema>,
	Response extends AnySchema | undefined,
> = {
	[K in keyof Replies | "error" | "response"]?: K extends "error"
		? (err: string) => void
		: K extends "response"
			? (value: InferOutput<Response>) => void
			: K extends keyof Replies
				? (value: InferOutput<Replies[K & keyof Replies]>) => void
				: never;
};

export interface RpcCallArgs<Route extends RpcRoute> {
	params: RouteParams<Route["name"] & string>;
	payload: InferOutput<Route["payload"]>;
	callbacks: RpcCallbacks<Route["replies"], Route["response"]>;
}

export interface OnDataArgs<Route extends DataRoute> {
	params: RouteParams<Route["name"] & string>;
	callback: (data: InferOutput<Route["schema"]>) => void;
}

export interface BuildClientOptions {
	transport: WaycastClientTransport;
	codec?: Codec;
	logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface WaycastClient<Routes extends Record<string, AnyRoute>> {
	rpc<Name extends RpcRouteNames<Routes>>(
		name: Name,
		args: ParamsArg<Name & string> & {
			payload: InferOutput<Extract<Routes[Name], RpcRoute>["payload"]>;
			callbacks: RpcCallbacks<
				Extract<Routes[Name], RpcRoute>["replies"],
				Extract<Routes[Name], RpcRoute>["response"]
			>;
		},
	): () => void;
	onData<Name extends DataRouteNames<Routes>>(
		name: Name,
		args: ParamsArg<Name & string> & {
			callback: (
				data: InferOutput<Extract<Routes[Name], DataRoute>["schema"]>,
			) => void;
		},
	): () => void;
	disconnect(): void;
}

const DEBOUNCE_MS = 50;

interface PendingRpc {
	name: string;
	topic: string;
	callbacks: RpcCallbacks<Record<string, AnySchema>, AnySchema | undefined>;
	expireTimer?: ReturnType<typeof setTimeout>;
}

export function buildClient<Routes extends Record<string, AnyRoute>>(
	router: Waycast<unknown, Routes>,
	options: BuildClientOptions,
): WaycastClient<Routes> {
	const transport = options.transport;
	const codec = options.codec ?? jsonCodec;
	const logger = options.logger;
	const fingerprint = computeRouterFingerprint(router._routes);
	const maxDisconnectionDuration = router.options.maxDisconnectionDuration;

	let handshakeOk = false;
	let hasConnectedOnce = false;

	const pendingRpc = new Map<string, PendingRpc>();
	const dataSubscriptions = new Map<string, Set<(data: unknown) => void>>();

	const pendingSubscribe = new Set<string>();
	const pendingUnsubscribe = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	// most transports (e.g. ws WebSocket) silently swallow send() calls made before the
	// connection opens — queue here and flush on handshake-ok instead of dropping
	const outbox: ClientMessage[] = [];

	function send(message: ClientMessage) {
		transport.send(codec.encode(message));
	}

	function sendWhenReady(message: ClientMessage) {
		if (handshakeOk) send(message);
		else outbox.push(message);
	}

	function scheduleFlush() {
		if (flushTimer || !handshakeOk) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			if (pendingSubscribe.size > 0) {
				send({ type: "subscribe", topics: [...pendingSubscribe] });
				pendingSubscribe.clear();
			}
			if (pendingUnsubscribe.size > 0) {
				send({ type: "unsubscribe", topics: [...pendingUnsubscribe] });
				pendingUnsubscribe.clear();
			}
		}, DEBOUNCE_MS);
	}

	function queueSubscribe(topic: string) {
		pendingUnsubscribe.delete(topic);
		pendingSubscribe.add(topic);
		scheduleFlush();
	}

	function queueUnsubscribe(topic: string) {
		pendingSubscribe.delete(topic);
		pendingUnsubscribe.add(topic);
		scheduleFlush();
	}

	function resolvePendingRpc(topic: string, key: string, value: unknown) {
		const pending = pendingRpc.get(topic);
		if (!pending) return;

		const callback = (
			pending.callbacks as Record<
				string,
				((value: unknown) => void) | undefined
			>
		)[key];
		callback?.(value);

		if (key === "error") {
			if (pending.expireTimer) clearTimeout(pending.expireTimer);
			pendingRpc.delete(topic);
		} else if (key === "response") {
			if (pending.expireTimer) clearTimeout(pending.expireTimer);
			pendingRpc.delete(topic);
			queueUnsubscribe(topic);
		}
	}

	transport.connect({
		onOpen() {
			handshakeOk = false;
			send({ type: "handshake", fingerprint });
		},
		onMessage(raw) {
			let message: ServerMessage;
			try {
				message = codec.decode(raw) as ServerMessage;
			} catch (err) {
				logger?.error?.(err);
				return;
			}

			switch (message.type) {
				case "handshake": {
					if (!message.ok) {
						logger?.error?.(
							new Error(
								"Waycast handshake mismatch: client and server routers are incompatible",
							),
						);
						return;
					}
					handshakeOk = true;
					for (const queued of outbox.splice(0)) send(queued);

					// on initial connect, pending rpc topics are created server-side as part
					// of handling the "rpc" message — resubscribing here would race ahead of
					// that and get rejected. Only resubscribe on reconnect.
					if (hasConnectedOnce) {
						for (const topic of pendingRpc.keys()) queueSubscribe(topic);
					}
					hasConnectedOnce = true;

					for (const topic of dataSubscriptions.keys()) queueSubscribe(topic);
					scheduleFlush();
					return;
				}
				case "publish": {
					if (pendingRpc.has(message.topic)) {
						const envelope = message.payload as ReplyEnvelope;
						resolvePendingRpc(message.topic, envelope.key, envelope.value);
						return;
					}
					const callbacks = dataSubscriptions.get(message.topic);
					if (callbacks)
						for (const callback of callbacks) callback(message.payload);
					return;
				}
				case "subscribe-rejected": {
					logger?.warn?.(
						`Waycast subscribe rejected for "${message.topic}": ${message.reason}`,
					);
					if (pendingRpc.has(message.topic))
						resolvePendingRpc(message.topic, "error", message.reason);
					return;
				}
			}
		},
		onClose() {
			handshakeOk = false;
			for (const pending of pendingRpc.values()) {
				pending.expireTimer = setTimeout(() => {
					resolvePendingRpc(
						pending.topic,
						"error",
						`Waycast: connection lost and did not reconnect within ${maxDisconnectionDuration}ms`,
					);
				}, maxDisconnectionDuration);
			}
		},
	});

	return {
		rpc(name, args) {
			const requestId = crypto.randomUUID();
			const topic = replyTopic(name as string, requestId);
			pendingRpc.set(topic, {
				name: name as string,
				topic,
				callbacks: args.callbacks as RpcCallbacks<
					Record<string, AnySchema>,
					AnySchema | undefined
				>,
			});
			sendWhenReady({
				type: "rpc",
				name: name as string,
				requestId,
				params: (args.params ?? {}) as Record<string, string>,
				payload: args.payload,
			});

			return () => {
				const pending = pendingRpc.get(topic);
				if (!pending) return;
				if (pending.expireTimer) clearTimeout(pending.expireTimer);
				pendingRpc.delete(topic);
				queueUnsubscribe(topic);
			};
		},
		onData(name, args) {
			const topic = buildRouteName(
				name as string,
				(args.params ?? {}) as Record<string, string>,
			);
			let callbacks = dataSubscriptions.get(topic);
			if (!callbacks) {
				callbacks = new Set();
				dataSubscriptions.set(topic, callbacks);
				queueSubscribe(topic);
			}
			callbacks.add(args.callback as (data: unknown) => void);

			return () => {
				const set = dataSubscriptions.get(topic);
				if (!set) return;
				set.delete(args.callback as (data: unknown) => void);
				if (set.size === 0) {
					dataSubscriptions.delete(topic);
					queueUnsubscribe(topic);
				}
			};
		},
		disconnect() {
			transport.disconnect();
		},
	};
}
