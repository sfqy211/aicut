import { EventEmitter } from "node:events";

export type AicutEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

class EventBus extends EventEmitter {
  publish(type: string, payload: Record<string, unknown> = {}) {
    const event: AicutEvent = { type, payload, createdAt: Date.now() };
    this.emit("event", event);
  }
}

export const eventBus = new EventBus();
