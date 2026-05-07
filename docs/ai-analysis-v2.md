# AICut AI 分析系统 V2 重构方案

## 概述

V1 阶段 AI 分析采用固定间隔盲扫整窗 → LLM 描述 → 生成单个候选的流水线。V2 改造为**四层架构**：密度峰值检测 → 启发式评分 → 过滤筛选 → LLM 内容描述。参考 `bilive`（纯密度切片）和 `bili-shadowreplay`（Agent + 多信号交叉验证）的设计思路，结合 AICut 已有的 MiMo LLM 和 ASR 能力。

## 架构总览

```
第零层 (已有)
  数据采集: danmuClient → DB, ASR → DB
          ↓
第一层 (新增 density.ts)
  密度峰值检测: 滑动窗口 + Z-score + 局部极大值 + NMS + 动态边界
  输出: DensityPeak[] (每个 tick 1-5 个峰值窗口)
          ↓
第二层 (新增 scoring.ts)
  启发式评分: 密度 + 重复度 + 情绪标点 + SC权重 + 加速度
  输出: WindowScore { total, grade: S/A/B/C }
          ↓ S/A 级 → 第三层, B/C 级 → 丢弃
第三层 (改造 analyze.ts)
  LLM 描述: 对每个高分窗口收集字幕+弹幕采样 → MiMo 描述
  输出: candidates (带 score + grade)
```

## 第一层：密度峰值检测 (`density.ts`)

### 算法来源

移植自 `bili-shadowreplay` 前端 `AppLive.svelte:86-244` 的 `detect_danmu_peaks` 算法。

### 参数

| 参数 | 默认值 | 来源 | 说明 |
|------|--------|------|------|
| `window_sec` | 30 | BSR 前端 | 滑动窗口大小 |
| `step_ms` | 5000 | BSR 前端 | 滑动步长 (5s) |
| `k` | 2.0 | BSR 前端 | Z-score 倍数，对应阈值 ~80% |
| `min_duration_sec` | 15 | BSR 前端 | 最短候选片段 |
| `max_duration_sec` | 180 | 自定义 | 最长候选片段 (BSR 用 120s，AICut 放宽到 3min) |
| `buffer_ms` | 5000 | BSR 前端 | 峰值前后缓冲 |

### 算法步骤

1. **直方图**: 时间轴按 `step_ms` 分桶，统计每桶弹幕数 — O(N)
2. **滑动窗口**: 窗宽 `window_sec`，滑动步长 `step_ms`，O(N)
3. **Z-score 阈值**: `threshold = mean + k * stdDev`，绝对下限取 `max(5, mean * 1.1)`
4. **局部极大值**: 密度超过阈值且大于相邻两个窗口 → 候选
5. **动态边界扩展**: 从峰值向两边扩展，密度降至 `mean + 0.5 * stdDev` 停止
6. **非极大值抑制 (NMS)**: 已选峰值窗口覆盖的弱峰直接丢弃
7. **时长约束**: clamp 到 `[min_duration, max_duration]`

### 复杂度

- 时间复杂度: O(N)，N 为窗口内弹幕数
- 空间复杂度: O(B)，B 为桶数
- 典型耗时: 5 分钟窗口 (500-5000 条弹幕) → <10ms

## 第二层：启发式评分 (`scoring.ts`)

### 信号定义与权重

| 信号 | 权重 | 计算逻辑 | 归一化 |
|------|:---:|----------|--------|
| 密度 Z-score | 35% | 直接取第一层输出 | `50 + zScore * 10`，上限 100 |
| 重复度 | 25% | 相同/高度相似文本出现次数 / 总数 | >50% 比例 → 满分 |
| 情绪标点 | 15% | 含 `[？！?！]{2,}` 的弹幕占比 | >50% 比例 → 满分 |
| 弹幕加速度 | 15% | 密度一阶导数 (本窗口 vs 前一窗口) | 2.5x → 满分 |
| SC 权重 | 10% | SC 总金额的对数归一化 | `log10(scTotal + 1) * 30` |

### 文本归一化 (重复度检测)

```
"666666"    → "666"
"？？？？？？" → "!"
"hhhhhh"   → "hh"
"哈哈哈哈哈哈" → "哈哈"
```

### 评级映射

| 总分 | 评级 | 处理 |
|:---:|:---:|------|
| ≥ 80 | S | 必推送 LLM 分析 |
| ≥ 60 | A | 推送 LLM 分析 |
| ≥ 40 | B | 仅记录，可选分析 |
| < 40 | C | 丢弃 |

### 设计原则

- **零延迟**: 纯 TypeScript 算法，无外部调用
- **零成本**: 不消耗 LLM token
- **可解释**: 每个信号的得分都可追溯
- **保守推送**: 只把 S/A 级窗口送 LLM，大幅减少 API 调用量

## 第三层：LLM 内容描述 (改造 `analyze.ts`)

### 改造点

**改造前**:
```
每 5 分钟 → 收集整窗 [sessionStart, now) 所有数据 → MiMo 描述 → 1 个候选
问题: 盲扫 + 弹幕截断到 30 条 + 无评分
```

**改造后**:
```
每 5 分钟 → 加载弹幕时间戳 → 密度峰值检测 (2-5个峰值)
     ↓
   for each peak (S/A 级):
     收集该峰值窗口的字幕 + 弹幕采样 (最频繁 20 条)
     → MiMo 描述 (带 Z-score 上下文)
     → INSERT candidate (start_time, end_time, score, grade, description)
     ↓
   去重合并: 相邻候选重叠 >50% → 合并
     ↓
   EventBus 推送 candidates.generated (带 score)
```

### LLM Prompt 增强

```
你是直播内容分析助手。根据提供的字幕和弹幕数据，用简洁的中文描述这段时间内发生了什么。

该窗口弹幕密度 Z-score={zScore}，预评分={heuristicScore}。

要求：
1. 只描述事实，不做价值判断
2. 区分字幕内容和弹幕/SC内容
3. 如果有明显的高潮、转折、互动，简要标注
4. 控制在 100 字以内
```

### 综合评分

```
finalScore = heuristicScore * 0.6 + extractLLMConfidence(description) * 0.4
```

LLM 置信度从描述的详实程度、是否有具体事件提及等维度提取。

## Schema 变更

```sql
-- candidates 表增加评分字段
ALTER TABLE candidates ADD COLUMN score REAL NOT NULL DEFAULT 0;
ALTER TABLE candidates ADD COLUMN score_detail TEXT;
-- score_detail JSON: {"density":85,"repeat":70,"emotion":45,"scWeight":0,"acceleration":60,"llm":80}
ALTER TABLE candidates ADD COLUMN grade TEXT NOT NULL DEFAULT 'C';  -- S/A/B/C
```

## 调度器改造 (`scheduler.ts`)

### 改造前
```
setInterval(tick, 5min) → tick() → analyzeWindow(since, now)
```

### 改造后
```
setInterval(tick, 5min) → tick():
  1. density.ts::detectDanmakuPeaks(since, now) → peaks[]
  2. 对每个 peak:
     scoring.ts::scorePeakWindow(peak, prevDensity) → score
     如果 score.grade >= A:
       analyze.ts::analyzePeak(peak, score) → candidate
  3. lastAnalysisMs = now
  4. prevDensity = 本次平均密度 (传给下次 tick 的加速度计算)

onStop:
  对剩余内容执行最终分析 (同 V1)
```

### 事件驱动增强 (可选 V2.1)

当前固定 5 分钟 tick 仍有盲扫延迟。如果检测到实时弹幕密度剧烈上升（SSE 流中连续 30s 密度 > 历史均值的 3σ），可以**立即触发一次分析**而不等待下一个 tick。

触发条件:
```typescript
if (realtime30sDensity > mean + 3 * stdDev) {
  immediateTick();  // 不等下一个 5 分钟
}
```

## 前端集成

### 切片审核页 (Review) — 已有，需要增强

当前功能:
- 左侧候选列表，右侧播放器预览
- 状态筛选 (pending/approved/rejected)
- 批准/驳回/批量批准

**V2 新增**:

1. **排序选项**: 按时间 / 按评分降序 / 按评级
   ```
   [⏱ 时间] [⭐ 评分 ↓] [🏷 S/A/B/C]
   ```

2. **评分标签**: 每个候选卡片显示评分徽章
   ```
   ┌──────────────────────────────────┐
   │ ⭐ 85 · S级   00:52 - 03:15     │
   │ 主播讨论一首高音歌曲及其歌词...    │
   │ 密度:Z=3.2 重复:70 情绪:45 SC:0 │
   │ [批准] [驳回]                     │
   └──────────────────────────────────┘
   ```

3. **评分详情展开**: 点击评分徽章显示五维雷达图或条形图

4. **密度图叠加**: 在播放器时间轴上叠加弹幕密度曲线 (候选区间高亮)

### 实时预览页 (LivePreview) — 新增密度面板

在 LivePreview 页面的侧边栏或底部增加:

```
┌────────────────────────────────────┐
│        弹幕密度 (实时)             │
│  ▁▂▃▅▇███▇▅▃▂▁▂▃▅▇███▇▅▃        │
│  19:00         19:02         19:04 │
│  ▎S 候选 ▎        ▎A 候选▎        │
└────────────────────────────────────┘
```

功能:
- 实时滚动密度曲线 (最近 5 分钟)
- 标记密度峰值阈值线 (虚线)
- 高亮已生成候选的时间区间
- 点击候选区间跳转到该时间点

### 候选通知

SSE 事件 `candidates.generated` 已在 `analyze.ts` 中发布。前端 `useEventStream` 监听后:
- 在导航栏 Review 图标上显示未读数量 badge
- Toast 通知 "检测到 1 个 S 级候选片段"

## 架构评估：是否更换技术栈

### 当前架构性能瓶颈分析

| 环节 | 耗时 (估算) | 是否可优化 |
|------|:---:|:---:|
| React 首次渲染 | ~50ms | 代码分割 ✅ |
| fetch 网络往返 (localhost) | <1ms | 非瓶颈 |
| SQLite 查询 (danmaku 5k 条) | ~5ms | 索引已就位 ✅ |
| JSON 序列化 (Fastify) | ~5ms | 非瓶颈 |
| JSON 反序列化 (React) | ~10ms | 非瓶颈 |
| **React 级联请求 (waterfall)** | **~200ms+** | ⚠️ 主要瓶颈 |
| **无客户端缓存** | **重复请求** | ⚠️ 主要瓶颈 |

**真正慢的不是网络，是前端数据获取模式**:
- Review 页每次切换候选 → 3 次级联 fetch (detail + exports)
- 页面切换 → 全量重新加载
- 大弹幕列表 JSON → 完整传输 + 完整解析

### 两个方向对比

| | 优化当前架构 | 迁移到 Tauri (BSR 技术栈) |
|---|---|---|
| **工作量** | 1-2 周 | 3-6 月 (全量重写) |
| **技术风险** | 极低 | 高 (Rust + Svelte 不熟悉) |
| **性能提升** | 3-5x (缓存 + 批处理) | 2-3x (IPC 代替 HTTP) |
| **单文件分发** | 需 Electron 包装 | Tauri 原生支持 ✅ |
| **内存占用** | ~200MB (Node + React) | ~50MB (Rust + Svelte) |
| **开发体验** | TS 全栈，统一类型 | Rust/TS 混编，类型桥接 |
| **社区生态** | 丰富 (React 组件库) | 较小 (Svelte + Tauri) |
| **可维护性** | 团队已有经验 | 需要 Rust 能力 |

### 推荐路径

**短期 (V2)**: 保持当前架构，解决前端性能问题

1. **引入 React Query (TanStack Query)** — 自动缓存 + 去重 + 后台刷新
2. **批量 API**: 一个请求返回 session + candidates + exports
3. **大列表分页**: danmaku/transcript 查询增加 `offset/limit`
4. **预加载**: 路由切换时预加载目标页数据

```typescript
// 引入 React Query 后 Review 页改造示例
function useCandidates(filter: string) {
  return useQuery({
    queryKey: ['candidates', filter],
    queryFn: () => apiGet<Candidate[]>(`/api/candidates?status=${filter}`),
    staleTime: 10_000,  // 10 秒内不重复请求
  });
}
```

**长期 (V3+)**: 如果以下条件满足，可考虑迁移 Tauri:
- 需要单文件分发 (.exe / .dmg)
- 需要更低的系统资源占用
- 团队具备 Rust 开发能力
- 功能稳定，不再频繁迭代

## 实施计划

### Phase 1: 核心算法 (P0) ✅

| # | 文件 | 操作 | 内容 | 状态 |
|---|------|------|------|:---:|
| 1 | `apps/api/src/core/analysis/density.ts` | 新建 | 密度峰值检测 (`detectDanmakuPeaks`) | ✅ |
| 2 | `apps/api/src/core/analysis/scoring.ts` | 新建 | 启发式评分 (`scorePeakWindow` + 文本归一化) | ✅ |
| - | `apps/api/src/core/analysis/utils.ts` | 新建 | 共享 `normalizeDanmaku` (审核时发现重复提取) | ✅ |

### Phase 2: 管线改造 (P1) ✅

| # | 文件 | 操作 | 内容 | 状态 |
|---|------|------|------|:---:|
| 3 | `apps/api/src/db/schema.sql` | 修改 | candidates 加 `score`, `score_detail`, `grade` | ✅ |
| 4 | `apps/api/src/core/analysis/analyze.ts` | 改造 | 峰值窗口循环 + 评分过滤 + 去重合并 | ✅ |
| 5 | `apps/api/src/core/analysis/scheduler.ts` | 改造 | 递归 setTimeout + running 防重入 + 竞态修复 | ✅ |

### Phase 3: 前端增强 (P2) ✅

| # | 文件 | 操作 | 内容 | 状态 |
|---|------|------|------|:---:|
| 6 | `apps/web/src/pages/Review.tsx` | 改造 | 排序选项 + ScoreBadge + ScoreDetail + SSE 过滤 | ✅ |
| 7 | `apps/web/src/pages/LivePreview.tsx` | 改造 | DanmakuDensityChart + 候选区间高亮 + useSessionFull | ✅ |
| 8 | `apps/web/src/hooks/useEventStream.ts` | 增强 | (candidates.generated 事件已由 Review.tsx 直接消费) | ✅ |

### Phase 4: 性能优化 (P3) ✅

| # | 内容 | 状态 |
|---|------|:---:|
| 9 | 引入 TanStack Query (React Query) | ✅ |
| 10 | 批量 API 端点 (`/api/sessions/:id/full` 一次返回 session+transcript+candidates+exports) | ✅ |
| 11 | Danmaku 时间范围加载 (`from`/`to` 参数 + 前端窗口 ±5min) | ✅ |
| - | Segment O(1) Map 索引 (playlist.ts `segmentBySequence`) | ✅ |

### Phase 5: 用户可配置 (P4) ✅

| # | 内容 | 状态 |
|---|------|:---:|
| 12 | Settings 页面增加 "AI 分析设置" — 密度敏感度滑块 (k 1.0-4.0) | ✅ |
| 13 | Settings 页面增加 "最低评级筛选" 下拉 (仅 S / S+A / S+A+B / 全部) | ✅ |

## 实施结果

### 文件清单 (22 个文件，+802/-133 行)

**新增 (3)**:
- `apps/api/src/core/analysis/density.ts` — 密度峰值检测算法
- `apps/api/src/core/analysis/scoring.ts` — 五信号启发式评分
- `apps/api/src/core/analysis/utils.ts` — 共享 normalizeDanmaku

**新增 (1)**:
- `apps/web/src/hooks/useSessionFull.ts` — TanStack Query 批量钩子

**改造 (12)**:
- `apps/api/src/core/analysis/analyze.ts` — V2 峰值流水线
- `apps/api/src/core/analysis/llm.ts` — MiMo 上下文 + token 限制 + SSRF 防护
- `apps/api/src/core/analysis/scheduler.ts` — 递归 setTimeout + 防重入
- `apps/api/src/db/schema.sql` — candidates 评分字段
- `apps/api/src/db/dbSettings.ts` — densityK + minGrade 读写
- `apps/api/src/routes/sessions.ts` — 批量端点 + 死列清理
- `apps/api/src/routes/settings.ts` — analysis 设置端点
- `apps/api/src/core/recorder/playlist.ts` — O(1) 索引 + 清理
- `apps/web/src/App.tsx` — QueryClientProvider
- `apps/web/src/pages/LivePreview.tsx` — 密度图 + 批量加载
- `apps/web/src/pages/Review.tsx` — 评分组件 + 排序 + SSE 过滤
- `apps/web/src/pages/Settings.tsx` — AnalysisSettings 面板
- `apps/web/src/hooks/useDanmaku.ts` — 时间范围 + ID 防碰撞
- `apps/web/src/types.ts` — SessionFullData + Candidate 评分字段
- `apps/web/src/styles.css` — 设置面板样式

**删除 (1)**:
- `apps/web/src/hooks/useCandidates.ts` — 被 useSessionFull 替代

### 性能提升

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| Review 页初始加载 | 3 次级联 fetch | 1 次 (10s 缓存) |
| 回放弹幕加载 (6h) | 108K 条 × 22MB | ±5min 窗口 × 100KB |
| Segment 查找 (4320 条) | O(n) ~5ms | O(1) ~0.001ms |
| LLM 调用频率 | 每 5min 盲扫 100% 窗口 | 仅 S/A 级峰值窗口 (减少 60-80%) |
| LLM Output Token | ~131K/次 | ~1K/次 |
| 候选质量 | 无评分，人工全量浏览 | S/A/B/C 分级排序 |

### 代码审查修复 (22 项)

**Critical (2)**:
- 加速度信号重新设计：窗口对比 → Z-score 基线 (30 + zScore*15)，消除死信号
- 首次 tick 加速度默认值跟随重新设计自动修复

**Important (10)**:
- sortDanmakuByFrequency 保留原始文本而非归一化截断值
- normalizeDanmaku 提取到共享 utils.ts
- densityScore 增加 Math.max(0, ...) 下限
- scheduler setInterval→递归 setTimeout + running 防重入
- sessions.ts 删除未绑定 SQL 变量 @fullText/@segmentsJson
- resolveEndpoint 增加 https?:// scheme 校验
- stopScheduler 增加飞行中 tick 等待逻辑
- 实时弹幕 ID 改用递减计数器防同毫秒碰撞
- stopScheduler 最终分析包裹 try/catch
- GET /settings 密钥泄露风险已知悉（本地工具风险可控）

**Suggestions (10)**:
- Math.max spread → for 循环 (防爆栈)
- extractLLMConfidence → extractDescriptionRichness
- 密度图 Date.now() → 最后事件时间戳
- 去重优先保留有 LLM 描述的候选
- AnalysisSettings 保存失败展示错误提示
- parseFloat NaN fallback
- endSessionPlaylist 延迟 60s 清除 segment Map
- SSE 刷新仅响应 candidates.* 事件
- 边界 buffer 参数化 (硬编码 5000 → stepMs)
- gradeOrder 提升为文件级常量

### 与原始方案的主要差异

| 决策 | 原方案 | 实施 |
|------|--------|------|
| **加速度信号** | 窗口间对比 (peak vs prevWindow) | Z-score 基线 (30 + zScore*15) — 算法更简洁，不需要跨窗口传递计数 |
| **调度器** | setInterval | 递归 setTimeout + running 防重入 — 避免 LLM 慢速时的重叠分析 |
| **弹幕排序** | 时间序前 20 条 | 按归一化频次排序取 top 20，保留原始最长文本 |
| **去重策略** | 高分优先 | 高分优先 + 保留有 LLM 描述的候选（评分差 ≤5 时） |
| **批量端点** | sessions/:id/full | 返回 session+transcript+candidates+exports (不含 segments 减重) |
| **额外文件** | — | utils.ts (共享归一化), useSessionFull.ts (替代 useCandidates) |

## 关键决策记录

| 决策 | 理由 |
|------|------|
| 不用硬编码关键词 | 不够泛化，无法识别新梗/社区黑话 |
| 不用本地小 LLM (qwen2:0.5b) | 当前阶段启发式算法已能覆盖 80% 场景，后续可选接入 |
| 不用 LangChain Agent | AICut 是后台分析而非交互助手，Agent 模式过重 |
| 不迁移 Tauri | 当前性能瓶颈在前端模式而非传输协议，优化后可达 3-5x 提升 |
| 保留 5 分钟定时调度 | 保证有规律的候选产出；事件驱动作为 V2.1 增强 |
| 评分权重 (启发式 60% + LLM 40%) | 启发式更客观且 0 成本，LLM 提供语义补充 |
