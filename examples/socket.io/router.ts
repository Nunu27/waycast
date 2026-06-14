import { Type as t } from "@sinclair/typebox";
import { Router } from "../../src/router";

export interface Context {
	userId?: string;
}

export interface Meta {
	requireAuth?: boolean;
}

export const appRouter = new Router<Meta>({
	maxDisconnectionDuration: 5000,
})
	.data("system:alerts", t.String())
	.rpc("job:[jobId]:process", {
		payload: t.Object({ force: t.Boolean() }),
		replies: {
			progress: t.Object({ percent: t.Number() }),
			log: t.String(),
		},
		response: t.Boolean(),
		meta: { requireAuth: true },
	});

export type AppRouter = typeof appRouter;
