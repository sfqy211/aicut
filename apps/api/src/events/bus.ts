import { EventEmitter } from "node:events";

export type AicutEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

class EventBus extends EventEmitter {
  constructor() {
    super();
    // 多个源、SSE连接、ASR、分析等都会订阅，默认10个不够
    this.setMaxListeners(50);
  }

  publish(type: string, payload: Record<string, unknown> = {}) {
    const event: AicutEvent = { type, payload, createdAt: Date.now() };
    this.emit("event", event);
  }
}

export const eventBus = new EventBus();
