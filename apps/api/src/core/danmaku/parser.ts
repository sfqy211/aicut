import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { getDb } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";

type DanmakuEvent = {
  eventType: "danmaku" | "super_chat" | "gift" | "guard";
  timestampMs: number;
  text: string;
  userId: string | null;
  userName: string | null;
  price: number;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  trimValues: true
});

export function findDanmakuSidecar(videoPath: string): string | null {
  const parsed = path.parse(videoPath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.xml`),
    path.join(parsed.dir, `${parsed.name}.json`)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function importDanmakuForSegment(segmentId: number, danmakuPath: string): number {
  const events = parseDanmakuFile(danmakuPath);
  const db = getDb();
  db.prepare("DELETE FROM danmaku_events WHERE segment_id = ?").run(segmentId);

  const insert = db.prepare(
    `INSERT INTO danmaku_events (segment_id, event_type, timestamp_ms, text, user_id, user_name, price)
     VALUES (@segmentId, @eventType, @timestampMs, @text, @userId, @userName, @price)`
  );
  db.exec("BEGIN");
  try {
    for (const item of events) {
      insert.run({
        segmentId,
        eventType: item.eventType,
        timestampMs: item.timestampMs,
        text: item.text,
        userId: item.userId,
        userName: item.userName,
        price: item.price
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  eventBus.publish("segment.danmaku_imported", { segmentId, count: events.length });
  return events.length;
}

export function parseDanmakuFile(filePath: string): DanmakuEvent[] {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");

  if (ext === ".json") {
    return parseJsonDanmaku(content);
  }

  return parseXmlDanmaku(content);
}

function parseXmlDanmaku(content: string): DanmakuEvent[] {
  const parsed = parser.parse(content);
  const root = parsed?.i ?? parsed;
  const result: DanmakuEvent[] = [];

  for (const item of asArray(root?.d)) {
    const p = String(item?.p ?? "");
    const progressSeconds = Number(p.split(",")[0] ?? 0);
    result.push({
      eventType: "danmaku",
      timestampMs: Math.max(0, Math.round(progressSeconds * 1000)),
      text: String(item?.text ?? item ?? ""),
      userId: item?.uid ? String(item.uid) : null,
      userName: item?.user ? String(item.user) : null,
      price: 0
    });
  }

  for (const item of asArray(root?.sc)) {
    result.push({
      eventType: "super_chat",
      timestampMs: secondsAttrToMs(item?.ts),
      text: String(item?.text ?? ""),
      userId: item?.uid ? String(item.uid) : null,
      userName: item?.user ? String(item.user) : null,
      price: xmlPriceToCents(item?.price)
    });
  }

  for (const item of asArray(root?.gift)) {
    result.push({
      eventType: "gift",
      timestampMs: secondsAttrToMs(item?.ts),
      text: String(item?.giftname ?? "gift"),
      userId: item?.uid ? String(item.uid) : null,
      userName: item?.user ? String(item.user) : null,
      price: xmlPriceToCents(item?.price)
    });
  }

  for (const item of asArray(root?.guard)) {
    result.push({
      eventType: "guard",
      timestampMs: secondsAttrToMs(item?.ts),
      text: String(item?.giftname ?? "guard"),
      userId: item?.uid ? String(item.uid) : null,
      userName: item?.user ? String(item.user) : null,
      price: xmlPriceToCents(item?.price)
    });
  }

  return result.sort((a, b) => a.timestampMs - b.timestampMs);
}

function parseJsonDanmaku(content: string): DanmakuEvent[] {
  const parsed = JSON.parse(content);
  const messages = Array.isArray(parsed) ? parsed : parsed?.messages ?? [];
  const metaStart = Number(parsed?.meta?.recordStartTimestamp ?? 0);

  return asArray(messages)
    .map((message): DanmakuEvent | null => {
      const timestampMs = Math.max(0, Number(message.timestamp ?? 0) - metaStart);
      const senderName = message.sender?.name ?? message.sender?.uname ?? null;
      if (message.type === "comment") {
        return {
          eventType: "danmaku",
          timestampMs,
          text: String(message.text ?? ""),
          userId: message.sender?.uid ? String(message.sender.uid) : null,
          userName: senderName,
          price: 0
        };
      }
      if (message.type === "super_chat") {
        return {
          eventType: "super_chat",
          timestampMs,
          text: String(message.text ?? ""),
          userId: message.sender?.uid ? String(message.sender.uid) : null,
          userName: senderName,
          price: yuanToCents(message.price)
        };
      }
      if (message.type === "give_gift") {
        return {
          eventType: "gift",
          timestampMs,
          text: String(message.name ?? "gift"),
          userId: message.sender?.uid ? String(message.sender.uid) : null,
          userName: senderName,
          price: yuanToCents(message.price)
        };
      }
      if (message.type === "guard") {
        return {
          eventType: "guard",
          timestampMs,
          text: String(message.name ?? "guard"),
          userId: message.sender?.uid ? String(message.sender.uid) : null,
          userName: senderName,
          price: yuanToCents(message.price)
        };
      }
      return null;
    })
    .filter((item): item is DanmakuEvent => item != null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function secondsAttrToMs(value: unknown): number {
  return Math.max(0, Math.round(Number(value ?? 0) * 1000));
}

function xmlPriceToCents(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric / 10) : 0;
}

function yuanToCents(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}
