import type { FastifyPluginAsync } from "fastify";
import { eventBus, type AicutEvent } from "../events/bus.js";

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/events/stream", async (_request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });

    const send = (event: AicutEvent) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      send({ type: "heartbeat", payload: {}, createdAt: Date.now() });
    }, 15000);

    eventBus.on("event", send);
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      eventBus.off("event", send);
    });
  });
};
