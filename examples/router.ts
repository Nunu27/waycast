import { z } from "zod";
import { Waycast } from "../src/index.ts";

export const router = new Waycast()
	.rpc("echo", {
		payload: z.object({ message: z.string() }),
		response: z.string(),
		replies: { info: z.string() },
	})
	.data("room:[id]:messages", z.string());

export type Router = typeof router;
