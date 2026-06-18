import type { Static, TSchema, TVoid } from "@sinclair/typebox";

import type { BaseLogger } from "pino";

export type AdapterLogger = Pick<
	BaseLogger,
	"debug" | "info" | "warn" | "error"
>;

export type Prettify<in out T> = {
	[K in keyof T]: T[K];
} & {};

export type MaybePromise<T> = T | Promise<T>;

export type ExtractParamNames<T extends string> =
	T extends `${string}[${infer P}]${infer Rest}`
		? P | ExtractParamNames<Rest>
		: never;

export type ParamsOf<T extends string> = [ExtractParamNames<T>] extends [never]
	? undefined
	: Prettify<{ [K in ExtractParamNames<T>]: string }>;

export type WithParams<P, T> = undefined extends P
	? Prettify<{ params?: P } & T>
	: Prettify<{ params: P } & T>;

export type WithData<D> = undefined extends D ? { data?: D } : { data: D };

export type EmitArgs<P, D> =
	{} extends WithParams<P, WithData<D>>
		? [options?: Prettify<WithParams<P, WithData<D>>>]
		: [options: Prettify<WithParams<P, WithData<D>>>];

export interface RpcDef<
	Payload extends TSchema,
	Replies extends Record<string, TSchema> = {},
	Response extends TSchema = TVoid,
	Meta = any,
> {
	payload: Payload;
	replies: Replies;
	response: Response;
	meta: Meta;
}

export type CheckMeta<M> = [keyof M] extends [never]
	? { meta?: M }
	: undefined extends M
		? { meta?: M }
		: { meta: M };

export type DataMessage<DataRoutes extends Record<string, TSchema>> = {
	[K in keyof DataRoutes & string]: {
		name: K;
		topic: string;
		data: Static<DataRoutes[K]>;
	};
}[keyof DataRoutes & string];

export type RpcReplyMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = {
	[K in keyof RpcRoutes & string]: {
		requestId: string;
		name: K;
		reply:
			| {
					type: "response";
					data: Static<RpcRoutes[K]["response"]>;
			  }
			| {
					type: "error";
					data: string;
			  }
			| {
					[R in keyof RpcRoutes[K]["replies"] & string]: {
						type: R;
						data: Static<RpcRoutes[K]["replies"][R]>;
					};
			  }[keyof RpcRoutes[K]["replies"] & string];
	};
}[keyof RpcRoutes & string];

export interface ServerAdapters<
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	topic?: {
		subscribe: (connectionId: string, ...topics: string[]) => void;
		unsubscribe: (connectionId: string, ...topics: string[]) => void;
		hasSubscriber?: (topic: string) => MaybePromise<boolean>;
	};
	isClientConnected?: (connectionId: string) => MaybePromise<boolean>;
	disposal?: {
		schedule: (
			connectionId: string,
			topic: string,
			duration: number,
		) => MaybePromise<void>;
		cancel: (topic: string) => MaybePromise<void>;
	};

	emit: (topic: string, message: DataMessage<DataRoutes>) => void;

	reply: (topic: string, message: RpcReplyMessage<RpcRoutes>) => void;
	errorFormatter?: (error: unknown) => string;
	logger?: AdapterLogger;
}

export type RequestMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = {
	[K in keyof RpcRoutes & string]: Prettify<{
		requestId: string;
		name: K;
		params: ParamsOf<K>;
		payload: Static<RpcRoutes[K]["payload"]>;
	}>;
}[keyof RpcRoutes & string];

export type SendMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = {
	[K in keyof RpcRoutes & string]: Prettify<{
		requestId: string;
		name: K;
		params: ParamsOf<K>;
		payload: Static<RpcRoutes[K]["payload"]>;
	}>;
}[keyof RpcRoutes & string];

export interface ClientAdapters<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	send: (message: SendMessage<RpcRoutes>) => MaybePromise<void>;
	logger?: AdapterLogger;
}

export type RpcCallbacks<Def extends RpcDef<any, any, any, any>> = {
	response?: (data: Static<Def["response"]>) => void;
	error?: (err: string) => void;
} & {
	[K in keyof Def["replies"]]?: (data: Static<Def["replies"][K]>) => void;
};
