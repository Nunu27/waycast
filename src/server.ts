import type { WaycastAdapter } from "./adapter.ts";
import { createInMemoryAdapter } from "./adapter.ts";
import type { Codec } from "./codec.ts";
import { jsonCodec } from "./codec.ts";
import {
	ABANDON_TOPIC,
	type AbandonMessage,
	type ClientMessage,
	computeRouterFingerprint,
	isReplyTopic,
	type ReplyEnvelope,
	replyTopic,
	type ServerMessage,
} from "./protocol.ts";
import { buildRouteName, type ParamsArg } from "./route-name.ts";
import {
	type AnyRoute,
	type AnySchema,
	type DataRoute,
	type InferOutput,
	type RouteParams,
	RouteRegistry,
	type RpcRoute,
	type Waycast,
} from "./router.ts";
import type { WaycastDisposalScheduler } from "./scheduler.ts";
import { createInMemoryDisposalScheduler } from "./scheduler.ts";
import type { WaycastServerTransport } from "./transport.ts";

export type MiddlewareNext = <
	Extra extends object = Record<string, never>,
>(opts?: {
	context: Extra;
}) => Promise<unknown>;

export interface MiddlewareParams<Context, Meta> {
	type: "rpc" | "data";
	name: string;
	params: Record<string, string>;
	meta: Meta | undefined;
	context: Context;
	connectionId: string;
	next: MiddlewareNext;
}

export type Middleware<Context, Meta> = (
	params: MiddlewareParams<Context, Meta>,
) => Promise<unknown>;

type RpcRouteNames<Routes> = {
	[K in keyof Routes]: Routes[K] extends RpcRoute ? K : never;
}[keyof Routes];
type DataRouteNames<Routes> = {
	[K in keyof Routes]: Routes[K] extends DataRoute ? K : never;
}[keyof Routes];

// Full reply surface — used by server.reply(); includes "error" and "response" built-ins
export type ReplyFn<Route extends RpcRoute> = <
	Key extends keyof Route["replies"] | "error" | "response",
>(
	key: Key & string,
	value: Key extends "error"
		? string
		: Key extends "response"
			? InferOutput<Route["response"]>
			: InferOutput<Route["replies"][Key & keyof Route["replies"]]>,
) => void;

// Narrowed reply for handler context — custom replies only; "response" is the return value, "error" comes from throw
export type HandlerReplyFn<Route extends RpcRoute> = <
	Key extends keyof Route["replies"],
>(
	key: Key & string,
	value: InferOutput<Route["replies"][Key & keyof Route["replies"]]>,
) => void;

export interface RpcHandlerArgs<Context, Route extends RpcRoute> {
	params: RouteParams<Route["name"]>;
	connectionId: string;
	requestId: string;
	payload: InferOutput<Route["payload"]>;
	context: Context;
	reply: HandlerReplyFn<Route>;
	signal: AbortSignal;
}

type MaybePromise<T> = Promise<T> | T;

export type RpcHandler<Context, Route extends RpcRoute> = (
	args: RpcHandlerArgs<Context, Route>,
) => undefined extends Route["response"]
	? MaybePromise<void>
	: MaybePromise<InferOutput<Route["response"]>>;

export interface BuildServerOptions<Context, Meta> {
	transport: WaycastServerTransport<Context>;
	codec?: Codec;
	adapter?: WaycastAdapter;
	disposalScheduler?: WaycastDisposalScheduler;
	logger?: Pick<Console, "log" | "warn" | "error">;
	middlewares?: Middleware<Context, Meta>[];
	errorFormatter?: (err: unknown) => string;
	onHandshakeMismatch?: (connectionId: string) => void;
}

export interface WaycastServer<
	Context,
	Routes extends Record<string, AnyRoute>,
> {
	on<Name extends RpcRouteNames<Routes>>(
		name: Name,
		handler: RpcHandler<Context, Extract<Routes[Name], RpcRoute>>,
	): void;
	onDispose<Name extends RpcRouteNames<Routes>>(
		name: Name,
		handler: (connectionId: string, requestId: string) => void,
	): void;
	reply<Name extends RpcRouteNames<Routes>>(
		name: Name,
		requestId: string,
	): ReplyFn<Extract<Routes[Name], RpcRoute>>;
	emit<Name extends DataRouteNames<Routes>>(
		name: Name,
		args: ParamsArg<Name & string> & {
			data: InferOutput<Extract<Routes[Name], DataRoute>["schema"]>;
		},
	): void;
	stop(): Promise<void>;
}

function defaultErrorFormatter(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

async function validatePayload(
	schema: AnySchema | undefined,
	value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	if (!schema) return { ok: true, value };
	const result = await schema["~standard"].validate(value);
	if (result.issues) {
		return {
			ok: false,
			error: result.issues.map((issue) => issue.message).join("; "),
		};
	}
	return { ok: true, value: result.value };
}

async function runMiddlewares<Context, Meta>(
	middlewares: Middleware<Context, Meta>[],
	base: Omit<MiddlewareParams<Context, Meta>, "next" | "context">,
	context: Context,
	final: (context: Context) => Promise<unknown>,
): Promise<unknown> {
	let cursor = -1;

	async function dispatch(index: number, ctx: Context): Promise<unknown> {
		if (index <= cursor) throw new Error("next() called multiple times");
		cursor = index;

		if (index === middlewares.length) return final(ctx);

		const middleware = middlewares[index] as Middleware<Context, Meta>;
		let nextCalled = false;
		const next: MiddlewareNext = async (opts) => {
			nextCalled = true;
			const merged = opts?.context
				? (Object.assign({}, ctx, opts.context) as Context)
				: ctx;
			return dispatch(index + 1, merged);
		};

		const result = await middleware({ ...base, context: ctx, next });
		if (!nextCalled) throw new Error("middleware short-circuited the request");
		return result;
	}

	return dispatch(0, context);
}

interface RpcRequestState {
	name: string;
	requestId: string;
	connectionId: string;
	topic: string;
	controller: AbortController;
}

export function buildServer<
	Context,
	Meta,
	Routes extends Record<string, AnyRoute>,
>(
	router: Waycast<Meta, Routes>,
	options: BuildServerOptions<Context, Meta>,
): WaycastServer<Context, Routes> {
	const transport = options.transport;
	const codec = options.codec ?? jsonCodec;
	const adapter = options.adapter ?? createInMemoryAdapter();
	const disposalScheduler =
		options.disposalScheduler ?? createInMemoryDisposalScheduler();
	const logger = options.logger;
	const middlewares = options.middlewares ?? [];
	const errorFormatter = options.errorFormatter ?? defaultErrorFormatter;
	const onHandshakeMismatch =
		options.onHandshakeMismatch ??
		((connectionId) => transport.disconnect(connectionId));

	const registry = new RouteRegistry(router._routes);
	const fingerprint = computeRouterFingerprint(router._routes);

	// biome-ignore lint/suspicious/noExplicitAny: type-erased storage; concrete route type is checked at .on() call site
	const rpcHandlers = new Map<string, RpcHandler<Context, any>>();
	const disposeHandlers = new Map<
		string,
		(connectionId: string, requestId: string) => void
	>();

	const connectionContexts = new Map<string, Context>();
	const connectionTopics = new Map<string, Set<string>>();
	const localTopicMembers = new Map<string, Set<string>>();
	const rpcRequests = new Map<string, RpcRequestState>();

	function trackLocal(connectionId: string, topic: string) {
		let members = localTopicMembers.get(topic);
		if (!members) {
			members = new Set();
			localTopicMembers.set(topic, members);
		}
		members.add(connectionId);

		let topics = connectionTopics.get(connectionId);
		if (!topics) {
			topics = new Set();
			connectionTopics.set(connectionId, topics);
		}
		topics.add(topic);
	}

	function untrackLocal(connectionId: string, topic: string) {
		const members = localTopicMembers.get(topic);
		if (members) {
			members.delete(connectionId);
			if (members.size === 0) localTopicMembers.delete(topic);
		}
		connectionTopics.get(connectionId)?.delete(topic);
	}

	async function subscribe(connectionId: string, topic: string) {
		trackLocal(connectionId, topic);
		await adapter.subscribe(connectionId, topic);
	}

	async function unsubscribe(connectionId: string, topic: string) {
		untrackLocal(connectionId, topic);
		await adapter.unsubscribe(connectionId, topic);
	}

	adapter.onMessage((topic, raw) => {
		if (topic === ABANDON_TOPIC) {
			const { topic: abandoned } = codec.decode(raw) as AbandonMessage;
			disposeRequest(abandoned);
			return;
		}
		const members = localTopicMembers.get(topic);
		if (!members) return;
		for (const connectionId of members) transport.send(connectionId, raw);
	});

	function disposeRequest(topic: string) {
		const state = rpcRequests.get(topic);
		if (!state) return; // idempotent — already disposed via another trigger
		rpcRequests.delete(topic);
		state.controller.abort();
		void disposalScheduler.cancel(topic);
		disposeHandlers.get(state.name)?.(state.connectionId, state.requestId);
	}

	disposalScheduler.onDue((topic) => disposeRequest(topic));

	function publish(topic: string, payload: unknown) {
		const message: ServerMessage = { type: "publish", topic, payload };
		void adapter.publish(topic, codec.encode(message));
	}

	// biome-ignore lint/suspicious/noExplicitAny: type-erased helper; callers hold the concrete ReplyFn type
	function makeReply(topic: string): ReplyFn<any> {
		return (key, value) => {
			const envelope: ReplyEnvelope = { key, value };
			publish(topic, envelope);
		};
	}

	async function handleRpc(
		connectionId: string,
		context: Context,
		message: Extract<ClientMessage, { type: "rpc" }>,
	) {
		const topic = replyTopic(message.name, message.requestId);
		await subscribe(connectionId, topic);
		const controller = new AbortController();
		rpcRequests.set(topic, {
			name: message.name,
			requestId: message.requestId,
			connectionId,
			topic,
			controller,
		});

		const reply = makeReply(topic);

		async function fail(error: string) {
			reply("error", error);
			await unsubscribe(connectionId, topic);
			disposeRequest(topic);
		}

		// message.name is the literal route template (e.g. "greet:[name]"), not a substituted
		// string — params arrive separately in message.params, so this is an exact map lookup,
		// not the regex-based registry.resolve() used for concrete topic strings
		const route = router._routes.get(message.name);
		if (route?.kind !== "rpc") {
			await fail(`Unknown rpc route "${message.name}"`);
			return;
		}

		const handler = rpcHandlers.get(message.name);
		if (!handler) {
			await fail(`No handler registered for rpc route "${message.name}"`);
			return;
		}

		const validated = await validatePayload(route.payload, message.payload);
		if (!validated.ok) {
			await fail(validated.error);
			return;
		}

		try {
			const result = await runMiddlewares(
				middlewares,
				{
					type: "rpc",
					name: message.name,
					params: message.params,
					meta: route.meta as Meta | undefined,
					connectionId,
				},
				context,
				async (ctx) =>
					handler({
						params: message.params,
						connectionId,
						requestId: message.requestId,
						payload: validated.value,
						context: ctx,
						reply,
						signal: controller.signal,
					}),
			);
			if (result !== undefined) reply("response", result);
		} catch (err) {
			logger?.error?.(err);
			await fail(errorFormatter(err));
		}
	}

	async function handleSubscribe(
		connectionId: string,
		context: Context,
		topics: string[],
	) {
		for (const topic of topics) {
			const pending = rpcRequests.get(topic);
			if (pending) {
				pending.connectionId = connectionId;
				await subscribe(connectionId, topic);
				await disposalScheduler.cancel(topic);
				continue;
			}

			const resolved = registry.resolve(topic);
			if (resolved?.def.kind !== "data") {
				// this instance doesn't own the pending rpc for this reply topic — broadcast in
				// case another instance does, so it can dispose now instead of waiting out its
				// disconnect grace period
				if (isReplyTopic(topic)) {
					void adapter.publish(
						ABANDON_TOPIC,
						codec.encode({ topic } satisfies AbandonMessage),
					);
				}
				send(connectionId, {
					type: "subscribe-rejected",
					topic,
					reason: `Unknown topic "${topic}"`,
				});
				continue;
			}

			try {
				await runMiddlewares(
					middlewares,
					{
						type: "data",
						name: resolved.def.name,
						params: resolved.params,
						meta: resolved.def.meta as Meta | undefined,
						connectionId,
					},
					context,
					async () => {
						await subscribe(connectionId, topic);
					},
				);
			} catch (err) {
				send(connectionId, {
					type: "subscribe-rejected",
					topic,
					reason: errorFormatter(err),
				});
			}
		}
	}

	async function handleUnsubscribe(connectionId: string, topics: string[]) {
		for (const topic of topics) {
			await unsubscribe(connectionId, topic);
			disposeRequest(topic);
		}
	}

	function send(connectionId: string, message: ServerMessage) {
		transport.send(connectionId, codec.encode(message));
	}

	transport.start({
		onConnection(connectionId, context) {
			connectionContexts.set(connectionId, context);
		},
		async onMessage(connectionId, raw) {
			if (!connectionContexts.has(connectionId)) return;
			const context = connectionContexts.get(connectionId) as Context;

			let message: ClientMessage;
			try {
				message = codec.decode(raw) as ClientMessage;
			} catch (err) {
				logger?.error?.(err);
				return;
			}

			switch (message.type) {
				case "handshake": {
					if (message.fingerprint !== fingerprint) {
						send(connectionId, { type: "handshake", ok: false });
						onHandshakeMismatch(connectionId);
						return;
					}
					send(connectionId, { type: "handshake", ok: true });
					return;
				}
				case "subscribe":
					await handleSubscribe(connectionId, context, message.topics);
					return;
				case "unsubscribe":
					await handleUnsubscribe(connectionId, message.topics);
					return;
				case "rpc":
					await handleRpc(connectionId, context, message);
					return;
			}
		},
		async onDisconnection(connectionId) {
			const topics = connectionTopics.get(connectionId);
			connectionContexts.delete(connectionId);
			if (!topics) return;

			for (const topic of [...topics]) {
				untrackLocal(connectionId, topic);
				await adapter.unsubscribe(connectionId, topic);

				const pending = rpcRequests.get(topic);
				if (pending)
					await disposalScheduler.schedule(
						topic,
						router.options.maxDisconnectionDuration,
					);
			}
			connectionTopics.delete(connectionId);
		},
	});

	return {
		on(name, handler) {
			const key = name as string;
			if (rpcHandlers.has(key))
				throw new Error(`Handler for rpc route "${key}" is already registered`);
			// biome-ignore lint/suspicious/noExplicitAny: downcasting to type-erased storage type
			rpcHandlers.set(key, handler as RpcHandler<Context, any>);
		},
		onDispose(name, handler) {
			const key = name as string;
			if (disposeHandlers.has(key))
				throw new Error(
					`Dispose handler for rpc route "${key}" is already registered`,
				);
			disposeHandlers.set(key, handler);
		},
		reply(name, requestId) {
			return makeReply(replyTopic(name as string, requestId));
		},
		emit(name, args) {
			const topic = buildRouteName(
				name as string,
				(args.params ?? {}) as Record<string, string>,
			);
			publish(topic, args.data);
		},
		async stop() {
			await transport.stop();
		},
	};
}
