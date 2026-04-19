import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface KeywordConfig {
  keyword: string;
  score: number;
  category: string;
  aliases: string[];
}

export interface KeywordCategoryConfig {
  weight: number;
  description: string;
}

export interface KeywordsFile {
  version: string;
  description: string;
  positive: KeywordConfig[];
  negative: KeywordConfig[];
  categories: Record<string, KeywordCategoryConfig>;
}

let cachedKeywords: KeywordsFile | null = null;

// 加载关键词配置
export function loadKeywordsConfig(): KeywordsFile {
  if (cachedKeywords) return cachedKeywords;

  const configPath = path.join(repoRoot, "config/keywords.json");

  if (!fs.existsSync(configPath)) {
    console.warn(`Keywords config not found at ${configPath}, using defaults`);
    return getDefaultKeywords();
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    cachedKeywords = JSON.parse(content) as KeywordsFile;
    return cachedKeywords;
  } catch (error) {
    console.error(`Failed to load keywords config: ${error}`);
    return getDefaultKeywords();
  }
}

// 默认关键词（配置文件不存在时使用）
function getDefaultKeywords(): KeywordsFile {
  return {
    version: "0.0.0",
    description: "Default keywords",
    positive: [
      { keyword: "666", score: 5, category: "惊喜", aliases: [] },
      { keyword: "牛逼", score: 5, category: "惊喜", aliases: [] },
      { keyword: "高能", score: 5, category: "高能", aliases: [] },
      { keyword: "笑死", score: 5, category: "搞笑", aliases: [] },
      { keyword: "泪目", score: 5, category: "感动", aliases: [] },
    ],
    negative: [
      { keyword: "无聊", score: -8, category: "负面", aliases: [] },
      { keyword: "尴尬", score: -6, category: "负面", aliases: [] },
    ],
    categories: {
      惊喜: { weight: 1.0, description: "" },
      搞笑: { weight: 1.0, description: "" },
      感动: { weight: 1.0, description: "" },
      高能: { weight: 1.2, description: "" },
      负面: { weight: 1.5, description: "" },
    },
  };
}

// 重新加载配置
export function reloadKeywordsConfig(): void {
  cachedKeywords = null;
  loadKeywordsConfig();
}

// 检查文本中的关键词命中
export function countKeywords(text: string): {
  positive: number;
  negative: number;
  hits: Array<{ keyword: string; score: number; category: string }>;
} {
  const config = loadKeywordsConfig();
  const lowerText = text.toLowerCase();
  const hits: Array<{ keyword: string; score: number; category: string }> = [];

  let positive = 0;
  let negative = 0;

  // 检查正向关键词
  for (const item of config.positive) {
    const matches = checkKeywordMatch(lowerText, item.keyword, item.aliases);
    if (matches > 0) {
      const categoryWeight = config.categories[item.category]?.weight ?? 1.0;
      const weightedScore = item.score * categoryWeight * matches;
      positive += weightedScore;
      hits.push({ keyword: item.keyword, score: weightedScore, category: item.category });
    }
  }

  // 检查负向关键词
  for (const item of config.negative) {
    const matches = checkKeywordMatch(lowerText, item.keyword, item.aliases);
    if (matches > 0) {
      const categoryWeight = config.categories[item.category]?.weight ?? 1.0;
      const weightedScore = Math.abs(item.score) * categoryWeight * matches;
      negative += weightedScore;
      hits.push({ keyword: item.keyword, score: -weightedScore, category: item.category });
    }
  }

  return { positive, negative, hits };
}

// 检查关键词匹配次数
function checkKeywordMatch(text: string, keyword: string, aliases: string[]): number {
  let count = 0;

  // 检查主关键词
  count += countOccurrences(text, keyword.toLowerCase());

  // 检查别名
  for (const alias of aliases) {
    count += countOccurrences(text, alias.toLowerCase());
  }

  return count;
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

// 获取所有关键词（用于展示）
export function getAllKeywords(): {
  positive: KeywordConfig[];
  negative: KeywordConfig[];
  categories: Record<string, KeywordCategoryConfig>;
} {
  const config = loadKeywordsConfig();
  return {
    positive: config.positive,
    negative: config.negative,
    categories: config.categories,
  };
}

// 获取关键词命中详情（用于 LLM 提示词）
export function getKeywordMatches(text: string): string {
  const result = countKeywords(text);
  if (result.hits.length === 0) {
    return "无关键词命中";
  }

  // 按分数降序排序
  const sorted = [...result.hits].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  // 格式化输出
  const details = sorted.slice(0, 10).map((hit) => {
    const sign = hit.score >= 0 ? "+" : "";
    return `${hit.keyword}(${sign}${hit.score.toFixed(1)}分,${hit.category})`;
  });

  return details.join("、");
}

// 向后兼容的导出
export const positiveKeywords = loadKeywordsConfig().positive.map((k) => k.keyword);
export const negativeKeywords = loadKeywordsConfig().negative.map((k) => k.keyword);
