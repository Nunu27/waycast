import type { Static, TSchema } from "typebox";

export type Prettify<in out T> = {
	[K in keyof T]: T[K];
} & {};

export type ExtractParamNames<T extends string> =
	T extends `${string}[${infer P}]${infer Rest}`
		? P | ExtractParamNames<Rest>
		: never;

export type ParamsOf<T extends string> = [ExtractParamNames<T>] extends [never]
	? undefined
	: Prettify<{ [K in ExtractParamNames<T>]: string }>;

export interface RpcDef<
	Payload extends TSchema,
	Replies extends Record<string, TSchema>,
	Response extends TSchema,
	Meta,
> {
	payload: Payload;
	replies: Replies;
	response: Response;
	meta: Meta;
}

export type DataMessage<DataRoutes extends Record<string, TSchema>> = Prettify<
	{
		[K in keyof DataRoutes & string]: {
			name: K;
			topic: string;
			data: Static<DataRoutes[K]>;
		};
	}[keyof DataRoutes & string]
>;

export type RpcReplyMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = Prettify<
	{
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
						data: any;
				  }
				| {
						[R in keyof RpcRoutes[K]["replies"] & string]: {
							type: R;
							data: Static<RpcRoutes[K]["replies"][R]>;
						};
				  }[keyof RpcRoutes[K]["replies"] & string];
		};
	}[keyof RpcRoutes & string]
>;

export interface ServerAdapters<
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	topic?: {
		subscribe: (connectionId: string, ...topics: string[]) => void;
		unsubscribe: (connectionId: string, ...topics: string[]) => void;
	};
	emit: (topic: string, message: DataMessage<DataRoutes>) => void;
	reply: (topic: string, message: RpcReplyMessage<RpcRoutes>) => void;
}

export type RequestMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = Prettify<
	{
		[K in keyof RpcRoutes & string]: {
			name: K;
			params: ParamsOf<K>;
			payload: Static<RpcRoutes[K]["payload"]>;
		};
	}[keyof RpcRoutes & string]
>;

export type SendMessage<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> = Prettify<
	{
		[K in keyof RpcRoutes & string]: {
			name: K;
			params: ParamsOf<K>;
			payload: Static<RpcRoutes[K]["payload"]>;
		};
	}[keyof RpcRoutes & string]
>;

export interface ClientAdapters<
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	send: (
		message: SendMessage<RpcRoutes>,
	) => string | Promise<string> | void | Promise<void>;
}

export type RpcCallbacks<Def extends RpcDef<any, any, any, any>> = Prettify<
	{
		response?: (data: Static<Def["response"]>) => void;
		error?: (err: any) => void;
	} & {
		[K in keyof Def["replies"]]?: (data: Static<Def["replies"][K]>) => void;
	}
>;
