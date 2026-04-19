# AICut 候选评分算法设计

## 问题分析

固定阈值的问题：
- 游戏直播：弹幕密集，100条/分钟很常见
- 聊天直播：弹幕稀疏，10条/分钟可能就是高能
- 音乐直播：弹幕集中在歌曲高潮
- 大主播 vs 小主播：数量级差异巨大

**结论**：阈值必须基于本场直播的**相对分布**动态计算。

---

## 动态阈值设计

### 核心思路

**"本场直播自己和自己比"** —— 使用统计学方法（百分位）确定高能区间。

### 数据采集阶段

转写完成后，先对整场直播进行统计：

```typescript
interface SessionStats {
  // 弹幕统计
  danmaku: {
    total: number;           // 总弹幕数
    duration: number;        // 总时长（秒）
    densityPerMin: number;   // 平均弹幕密度（条/分钟）
    // 按滑动窗口（30s）计算密度分布
    densityDistribution: number[];  // 每个窗口的弹幕数
    p50: number;  // 中位数
    p75: number;  // 75百分位
    p90: number;  // 90百分位
  };
  
  // 付费互动统计
  interaction: {
    totalSc: number;         // SC 总金额（分）
    totalGift: number;       // 礼物总金额（分）
    // 按滑动窗口计算付费分布
    priceDistribution: number[];
    p75: number;
    p90: number;
  };
  
  // 转写统计
  transcript: {
    totalWords: number;
    // 语速分布（字/分钟）
    speedDistribution: number[];
    // 音量峰值分布（需要从转写 segments 提取）
    energyDistribution: number[];
  };
}
```

### 阈值计算公式

```typescript
// 弹幕密度满分阈值 = P75（超过 75% 的片段）
const danmakuThreshold = stats.danmaku.p75;

// 付费满分阈值 = P90（超过 90% 的片段，付费更稀缺）
const interactionThreshold = stats.interaction.p90;

// 语速变化满分阈值 = P90
const energyThreshold = stats.transcript.energyDistribution.p90;
```

### 评分公式（0-100 分）

```typescript
function calculateScore(window: WindowData, stats: SessionStats): number {
  // 1. 弹幕密度分 (40分)
  // 使用 sigmoid 平滑映射，避免线性饱和
  const danmakuScore = 40 * sigmoid(
    (window.danmakuCount / stats.danmaku.p75 - 1) * 2
  );
  
  // 2. 付费互动分 (30分)
  const interactionScore = 30 * sigmoid(
    (window.priceTotal / stats.interaction.p90 - 1) * 2
  );
  
  // 3. 关键词分 (20分) - 固定规则
  const keywordHits = countKeywords(window.transcript);
  const keywordScore = Math.min(20, keywordHits * 5);
  
  // 4. 声音能量分 (10分)
  const energyScore = 10 * sigmoid(
    (window.energyPeak / stats.transcript.energyDistribution.p90 - 1) * 2
  );
  
  return danmakuScore + interactionScore + keywordScore + energyScore;
}

// Sigmoid 函数：x=0 时返回 0.5，x>0 快速趋近 1
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
```

---

## LLM 二次评分流程

### 触发条件

满足以下**任一条件**即触发 LLM 二次评分：

1. 规则总分 >= 60 分
2. 单维度分数 >= 该维度满分的 80%（如弹幕分 >= 32）
3. 付费金额 >= P95（极端高价值片段）

### LLM 输入

```typescript
interface LLMScoreInput {
  // 上下文
  streamerName: string;
  liveTitle: string;
  
  // 片段信息
  window: {
    startTime: number;
    endTime: number;
    duration: number;
  };
  
  // 数据摘要
  summary: {
    danmakuCount: number;
    danmakuDensity: number;      // 相对于平均值的倍数
    topDanmaku: string[];        // 高频弹幕（去重后 top 5）
    scTotal: number;             // SC 总金额
    scMessages: string[];        // SC 内容（最多 10 条）
    transcriptText: string;      // 转写文本（截取 500 字）
  };
  
  // 规则评分详情
  ruleScores: {
    total: number;
    danmaku: number;
    interaction: number;
    keyword: number;
    energy: number;
  };
}
```

### LLM Prompt 模板

```
你是一个直播切片专家，负责判断一个直播片段是否值得剪辑成短视频。

## 直播信息
- 主播：{{streamerName}}
- 标题：{{liveTitle}}

## 片段信息
- 时间：{{startTime}} - {{endTime}}（{{duration}}秒）
- 弹幕数：{{danmakuCount}} 条（是平均值的 {{danmakuDensity}} 倍）
- 高频弹幕：{{topDanmaku}}
- SC 金额：{{scTotal}} 元
- SC 内容：{{scMessages}}
- 转写文本：{{transcriptText}}

## 规则评分
- 总分：{{ruleScores.total}} / 100
- 弹幕分：{{ruleScores.danmaku}} / 40
- 互动分：{{ruleScores.interaction}} / 30
- 关键词分：{{ruleScores.keyword}} / 20
- 能量分：{{ruleScores.energy}} / 10

## 任务
请判断这个片段是否值得剪辑，并给出你的分析。

## 输出格式（JSON）
{
  "worth": boolean,           // 是否值得切
  "confidence": number,       // 置信度 0-1
  "category": string,         // 分类：高能/搞笑/感人/整活/技术/其他
  "highlight": string,        // 核心看点（一句话，20字内）
  "title": string,            // 推荐标题（带emoji，30字内）
  "reason": string,           // 推荐理由（50字内）
  "risk": string | null,      // 风险提示（如：争议言论、敏感词）
  "suggestedAdjustment": {    // 建议的时间调整（可选）
    "trimStart": number,      // 建议往前/往后移多少秒
    "trimEnd": number
  }
}
```

### 最终评分计算

```typescript
function calculateFinalScore(
  ruleScore: number,
  llmResult: LLMResult | null
): number {
  if (!llmResult) {
    // 未触发 LLM，使用规则分
    return ruleScore;
  }
  
  if (!llmResult.worth) {
    // LLM 判断不值得，降权
    return ruleScore * 0.5;
  }
  
  // LLM 确认值得，加权
  const llmBoost = llmResult.confidence * 20;  // 最多加 20 分
  const adjustedScore = ruleScore + llmBoost;
  
  // 风险惩罚
  const riskPenalty = llmResult.risk ? 15 : 0;
  
  return Math.min(100, Math.max(0, adjustedScore - riskPenalty));
}
```

---

## 实现结构

### 文件结构

```
apps/api/src/core/analysis/
├── scoring.ts           # 主入口：generateCandidates(sessionId)
├── stats.ts             # 统计计算：computeSessionStats(sessionId)
├── rules.ts             # 规则评分：calculateRuleScore(window, stats)
├── llm.ts               # LLM 评分：scoreWithLLM(input)
└── keywords.ts          # 关键词列表
```

### 主流程

```typescript
// scoring.ts
export async function generateCandidates(sessionId: number) {
  // 1. 计算整场直播统计
  const stats = await computeSessionStats(sessionId);
  
  // 2. 滑动窗口生成候选
  const windows = generateWindows(stats.duration, {
    minDuration: 45,
    maxDuration: 120,
    step: 15
  });
  
  // 3. 规则评分
  const scored = windows.map(window => ({
    ...window,
    ruleScore: calculateRuleScore(window, stats)
  }));
  
  // 4. 筛选需要 LLM 二次评分的窗口
  const llmCandidates = scored.filter(w => shouldCallLLM(w.ruleScore, stats));
  
  // 5. 并发调用 LLM（限制并发数）
  const llmResults = await Promise.all(
    llmCandidates.map(w => scoreWithLLM(w, stats).catch(() => null))
  );
  
  // 6. 合并结果，写入数据库
  for (const candidate of scored) {
    const llmResult = llmResults.find(r => r?.windowId === candidate.id);
    const finalScore = calculateFinalScore(candidate.ruleScore, llmResult);
    
    await insertCandidate({
      sessionId,
      ...candidate,
      finalScore,
      llmResult
    });
  }
  
  // 7. 发送事件
  eventBus.publish('candidates.generated', { sessionId, count: scored.length });
}
```

---

## 配置项

```typescript
// config.ts
export const analysisConfig = {
  // 窗口参数
  window: {
    minDuration: 45,      // 最小窗口（秒）
    maxDuration: 120,     // 最大窗口（秒）
    step: 15              // 步长（秒）
  },
  
  // 阈值百分位
  threshold: {
    danmaku: 75,          // 弹幕密度满分阈值 = P75
    interaction: 90,      // 付费满分阈值 = P90
    energy: 90            // 能量满分阈值 = P90
  },
  
  // LLM 触发条件
  llmTrigger: {
    minRuleScore: 60,     // 规则总分 >= 60
    minDimensionRatio: 0.8, // 单维度 >= 80%
    pricePercentile: 95   // 付费 >= P95
  },
  
  // LLM 配置
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout: 30000;
    maxConcurrency: 3     // 最大并发数
  }
};
```

---

## 关键词列表

```typescript
// keywords.ts
export const positiveKeywords = [
  // 表达惊喜/激动
  '666', 'nb', '牛逼', '厉害', '强', '绝了', '太强了',
  
  // 表达搞笑
  '哈哈哈', '笑死', '哈哈哈哈', '乐死', '笑不活了',
  
  // 表达感动
  '泪目', '哭了', '感动', '破防', '呜呜',
  
  // 表达高能
  '高能', '前方高能', '来了来了', '注意看',
  
  // 表达互动
  '爱了', '冲', '急', '救命', '神仙'
];

export const negativeKeywords = [
  '无聊', '没意思', '困了', '睡着了', '无聊死了'
];
```

---

## 数据库字段补充

```sql
-- candidates 表新增字段
ALTER TABLE candidates ADD COLUMN rule_score REAL DEFAULT 0;
ALTER TABLE candidates ADD COLUMN llm_score REAL;
ALTER TABLE candidates ADD COLUMN llm_category TEXT;
ALTER TABLE candidates ADD COLUMN llm_confidence REAL;
ALTER TABLE candidates ADD COLUMN llm_worth INTEGER;
ALTER TABLE candidates ADD COLUMN llm_risk TEXT;
ALTER TABLE candidates ADD COLUMN suggested_trim_start INTEGER DEFAULT 0;
ALTER TABLE candidates ADD COLUMN suggested_trim_end INTEGER DEFAULT 0;
```

---

*更新日期: 2026-04-19*
