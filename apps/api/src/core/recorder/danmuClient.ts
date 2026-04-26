import fs from "node:fs";
import { startListen } from "@bililive-tools/bilibili-recorder/lib/blive-message-listener/index.js";
import { getDb } from "../../db/index.js";
import { getDanmuPath, ensureSessionDir } from "../library/index.js";
import { eventBus } from "../../events/bus.js";

export interface DanmuMessage {
  type: "danmaku" | "super_chat" | "gift" | "guard";
  timestampMs: number;
  text: string;
  userId: string | null;
  userName: string | null;
  price: number;
  raw: unknown;
}

export interface DanmuClientOptions {
  roomId: string;
  sessionId: number;
  liveId: string;
  /** session 开始时的绝对时间戳（ms），用于计算相对时间 */
  sessionStartMs: number;
  cookie?: string;
  uid?: number;
}

/**
 * B站弹幕客户端
 * - 使用 blive-message-listener 连接 WebSocket
 * - 实时写入 danmu.txt
 * - 实时入库 danmaku_events（支持实时预览）
 */
export class DanmuClient {
  private opts: DanmuClientOptions;
  private listener: ReturnType<typeof startListen> | null = null;
  private danmuPath: string;
  private running = false;
  private insertStmt: ReturnType<ReturnType<typeof getDb>["prepare"]> | null = null;

  constructor(opts: DanmuClientOptions) {
    this.opts = opts;
    this.danmuPath = getDanmuPath(opts.roomId, opts.liveId);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    ensureSessionDir(this.opts.roomId, this.opts.liveId);

    // 预编译 INSERT 语句（提高高频写入性能）
    const db = getDb();
    this.insertStmt = db.prepare(
      `INSERT INTO danmaku_events (session_id, event_type, timestamp_ms, text, user_id, price)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // 构造 cookie（需要包含 buvid3，blive-message-listener 内部会补充）
    let lastAuth = "";
    if (this.opts.cookie) {
      lastAuth = this.opts.cookie;
    }

    const handler = {
      onIncomeDanmu: (msg: any) => {
        const content = String(msg.body.content ?? "").replace(/(^\s*)|(\s*$)/g, "").replace(/[\r\n]/g, "");
        if (!content) return;

        const ts = this.opts.sessionStartMs + msg.body.timestamp;
        const event: DanmuMessage = {
          type: "danmaku",
          timestampMs: ts,
          text: content,
          userId: String(msg.body.user?.uid ?? ""),
          userName: String(msg.body.user?.uname ?? ""),
          price: 0,
          raw: msg,
        };
        this.handleMessage(event);
      },

      onIncomeSuperChat: (msg: any) => {
        const content = String(msg.body.content ?? "").replace(/[\r\n]/g, "");
        const ts = this.opts.sessionStartMs + (msg.raw?.send_time ?? Date.now());
        const event: DanmuMessage = {
          type: "super_chat",
          timestampMs: ts,
          text: content,
          userId: String(msg.body.user?.uid ?? ""),
          userName: String(msg.body.user?.uname ?? ""),
          price: Number(msg.body.price ?? 0),
          raw: msg,
        };
        this.handleMessage(event);
      },

      onGuardBuy: (msg: any) => {
        const ts = this.opts.sessionStartMs + (msg.timestamp ?? Date.now());
        const event: DanmuMessage = {
          type: "guard",
          timestampMs: ts,
          text: String(msg.body.gift_name ?? "guard"),
          userId: String(msg.body.user?.uid ?? ""),
          userName: String(msg.body.user?.uname ?? ""),
          price: Number(msg.body.price ?? 0) / 1000,
          raw: msg,
        };
        this.handleMessage(event);
      },

      onGift: (msg: any) => {
        const ts = this.opts.sessionStartMs + (msg.raw?.data?.timestamp ? msg.raw.data.timestamp * 1000 : Date.now());
        const event: DanmuMessage = {
          type: "gift",
          timestampMs: ts,
          text: String(msg.body.gift_name ?? "gift"),
          userId: String(msg.body.user?.uid ?? ""),
          userName: String(msg.body.user?.uname ?? ""),
          price: msg.body.coin_type === "silver" ? 0 : Number(msg.body.price ?? 0) / 1000,
          raw: msg,
        };
        this.handleMessage(event);
      },
    };

    this.listener = startListen(Number(this.opts.roomId), handler, {
      ws: {
        headers: lastAuth ? { Cookie: lastAuth } : undefined,
        uid: this.opts.uid ?? 0,
      },
    });

    this.listener.live.on("error", (err: Error) => {
      console.error(`[DanmuClient] room=${this.opts.roomId} error:`, err.message);
      // 自动重连由 tiny-bilibili-ws 内部处理
    });
  }

  stop(): void {
    this.running = false;
    this.listener?.close();
    this.listener = null;
    this.insertStmt = null;
  }

  private handleMessage(msg: DanmuMessage): void {
    // 1. 追加到 danmu.txt
    const line = `${msg.timestampMs}:${JSON.stringify(msg)}\n`;
    fs.appendFileSync(this.danmuPath, line);

    // 2. 实时入库
    try {
      this.insertStmt?.run(
        this.opts.sessionId,
        msg.type,
        msg.timestampMs,
        msg.text,
        msg.userId,
        msg.price
      );
    } catch (err) {
      console.error(`[DanmuClient] DB insert error:`, err);
    }

    // 3. 发布事件（供实时预览）
    eventBus.publish("danmaku.received", {
      sessionId: this.opts.sessionId,
      type: msg.type,
      text: msg.text,
      timestampMs: msg.timestampMs,
      price: msg.price,
    });
  }
}

// --- danmu.txt 批量解析导入（Session 结束时调用）---

export interface ParsedDanmuEntry {
  type: "danmaku" | "super_chat" | "gift" | "guard";
  timestampMs: number;
  text: string;
  userId: string | null;
  price: number;
}

/**
 * 解析 danmu.txt 为标准化事件列表
 */
export function parseDanmuTxt(filePath: string): ParsedDanmuEntry[] {
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const results: ParsedDanmuEntry[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const jsonStr = line.slice(colonIdx + 1);
    try {
      const msg = JSON.parse(jsonStr) as DanmuMessage;
      results.push({
        type: msg.type,
        timestampMs: msg.timestampMs,
        text: msg.text,
        userId: msg.userId,
        price: msg.price,
      });
    } catch {
      // 忽略解析失败的行
    }
  }

  return results.sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * 从 danmu.txt 批量导入到 danmaku_events（兜底/重建用）
 */
export function importDanmuTxtToDb(sessionId: number, filePath: string): number {
  const events = parseDanmuTxt(filePath);
  if (events.length === 0) return 0;

  const db = getDb();
  db.prepare("DELETE FROM danmaku_events WHERE session_id = ?").run(sessionId);

  const insert = db.prepare(
    `INSERT INTO danmaku_events (session_id, event_type, timestamp_ms, text, user_id, price)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  db.exec("BEGIN");
  try {
    for (const item of events) {
      insert.run(sessionId, item.type, item.timestampMs, item.text, item.userId, item.price);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  eventBus.publish("segment.danmaku_imported", { sessionId, count: events.length });
  return events.length;
}
