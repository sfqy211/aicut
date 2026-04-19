// 正向关键词：命中增加评分
export const positiveKeywords = [
  // 表达惊喜/激动
  "666",
  "nb",
  "牛逼",
  "厉害",
  "强",
  "绝了",
  "太强了",
  "无敌",
  "神仙",
  "牛逼666",

  // 表达搞笑
  "哈哈哈",
  "哈哈哈哈",
  "笑死",
  "乐死",
  "笑不活了",
  "哈哈哈哈哈",
  "哈哈哈哈哈哈",
  "笑拉了",

  // 表达感动
  "泪目",
  "哭了",
  "感动",
  "破防",
  "呜呜",
  "泪崩",

  // 表达高能
  "高能",
  "前方高能",
  "来了来了",
  "注意看",
  "大事发生",
  "起立",

  // 表达互动
  "爱了",
  "冲",
  "急",
  "救命",
  "救命啊",
  "好家伙",
  "我的天",
  "卧槽",
  "我靠",
];

// 负向关键词：命中降低评分
export const negativeKeywords = [
  "无聊",
  "没意思",
  "困了",
  "睡着了",
  "无聊死了",
  "好无聊",
  "没劲",
  "尴尬",
  "太尬了",
];

// 检查文本中的关键词命中
export function countKeywords(text: string): {
  positive: number;
  negative: number;
  hits: string[];
} {
  const lowerText = text.toLowerCase();
  let positive = 0;
  let negative = 0;
  const hits: string[] = [];

  for (const keyword of positiveKeywords) {
    const count = countOccurrences(lowerText, keyword.toLowerCase());
    if (count > 0) {
      positive += count;
      hits.push(keyword);
    }
  }

  for (const keyword of negativeKeywords) {
    const count = countOccurrences(lowerText, keyword.toLowerCase());
    if (count > 0) {
      negative += count;
      hits.push(keyword);
    }
  }

  return { positive, negative, hits: [...new Set(hits)] };
}

function countOccurrences(text: string, pattern: string): number {
  if (!pattern) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(pattern, pos)) !== -1) {
    count++;
    pos += pattern.length;
  }
  return count;
}
