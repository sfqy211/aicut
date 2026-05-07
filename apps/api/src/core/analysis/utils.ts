/**
 * 归一化弹幕文本用于重复/近似检测。
 * 统一标点、数字、笑声，截断长文本。
 */
export function normalizeDanmaku(text: string): string {
  return text
    .replace(/[！!？?]+/g, "!") // 统一情绪标点
    .replace(/6{3,}/g, "666") // 统一 666
    .replace(/h{2,}/gi, "hh") // 统一 hhh
    .replace(/哈{2,}/g, "哈哈") // 统一 哈哈
    .replace(/\s+/g, "") // 去空格
    .trim()
    .slice(0, 30); // 截断长文本
}
