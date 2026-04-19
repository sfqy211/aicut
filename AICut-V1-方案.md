# AICut V1 优化方案

## 用户画像与约束

| 项目     | 实际情况                   | 方案适配                             |
| -------- | -------------------------- | ------------------------------------ |
| 硬件     | 16GB 内存，无显卡          | ASR 优先 CPU，small 模型，单队列处理 |
| API      | 已有 OpenAI/Claude API Key | 云端 LLM 分析，无需本地大模型        |
| 场景     | 自动录制 B站直播           | 录制进 Phase 1，24h 无人值守         |
| 用户类型 | 个人切片师，追求简单       | 精简配置，智能默认，一键操作         |

---

## 核心体验目标

**"录制 → 自动切片 → 勾选导出" 三步闭环**

1. **零配置启动**：本机自带 FFmpeg、下载 Whisper 模型、内置录制预设
2. **后台自动跑**：开播自动录，分段自动转写，转完自动分析
3. **人只做决策**：看候选片段，勾选要的，一键导出
4. **粗剪外包**：导出 MP4 + SRT，丢给剪映/PR 精修

---

## 技术栈（固定）

| 层级     | 选型                                 | 理由                                     |
| -------- | ------------------------------------ | ---------------------------------------- |
| 前端     | React + Vite + TypeScript + Tailwind | 参考项目主流，开发快                     |
| 后端     | Node.js + Fastify + TypeScript       | bililive-tools 同生态，事件驱动友好      |
| 数据库   | SQLite (better-sqlite3)              | 零配置，单文件备份                       |
| 录制     | @bililive-tools/manager              | 成熟 B站录制器，分段事件完善             |
| ASR      | Python + faster-whisper (CPU)        | 本地优先，small 模型 2GB 内存            |
| 媒体处理 | FFmpeg                               | 抽音频、截图、预览代理                   |
| LLM      | OpenAI 兼容 API                      | 用户已有 Key，支持 GPT/Claude/第三方代理 |

---

## 仓库结构

```
aicut/
├── apps/
│   ├── web/                 # React 控制台
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── Dashboard/       # 总览：录制中/待处理/已完成
│   │   │   │   ├── Sources/         # 直播源管理（房间号/Cookie）
│   │   │   │   ├── Session/         # 单场直播详情（分段/转写/候选）
│   │   │   │   ├── Review/          # 候选审核（播放器+勾选）
│   │   │   │   └── Exports/         # 导出历史
│   │   │   ├── components/
│   │   │   │   ├── Player/          # 视频播放器 + 时间轴
│   │   │   │   ├── CandidateCard/   # 候选片段卡片
│   │   │   │   ├── TranscriptView/  # 转写文本展示
│   │   │   │   └── DanmakuHeatmap/  # 弹幕密度热力图
│   │   │   └── api/                 # 前端 API 客户端
│   │   └── package.json
│   │
│   └── api/                 # Fastify 后端
│       ├── src/
│       │   ├── core/
│       │   │   ├── recorder/        # 录制器管理（bililive-tools 封装）
│       │   │   ├── asr/             # ASR 任务队列与调用
│       │   │   ├── analysis/        # 候选生成（规则评分 + LLM）
│       │   │   ├── export/          # 视频导出（FFmpeg）
│       │   │   └── library/         # 文件管理
│       │   ├── routes/
│       │   │   ├── sources.ts       # 直播源 CRUD
│       │   │   ├── sessions.ts      # 会话查询
│       │   │   ├── candidates.ts    # 候选片段查询/审核
│       │   │   ├── exports.ts       # 导出任务
│       │   │   └── events.ts        # SSE 实时推送
│       │   ├── db/
│       │   │   ├── schema.sql       # 表结构
│       │   │   └── index.ts         # 数据库连接
│       │   └── index.ts             # 服务入口
│       └── package.json
│
├── services/
│   └── asr-worker/          # Python ASR 服务
│       ├── main.py          # FastAPI 服务入口
│       ├── whisper_worker.py # 转写逻辑
│       ├── config.py        # 模型配置
│       └── requirements.txt
│
├── library/                 # 数据目录（gitignore）
│   ├── sources/             # 原始录制文件
│   ├── transcripts/         # 转写结果 JSON
│   ├── candidates/          # 候选片段元数据
│   └── exports/             # 导出成品
│
├── scripts/
│   ├── dev.js               # 一键启动（Node + Python）
│   ├── check-env.js         # 环境检测（模型）
│   └── download-model.js    # 自动下载 whisper small 模型
│
└── package.json             # workspace root
```

---

## 数据模型（精简版）

### 核心表

```sql
-- 直播源配置
CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    platform TEXT DEFAULT 'bilibili',  -- 只支持 B站
    room_id TEXT NOT NULL UNIQUE,
    streamer_name TEXT,
    cookie TEXT,                       -- B站登录 Cookie
    auto_record BOOLEAN DEFAULT 1,     -- 自动录制开关
    output_dir TEXT,                   -- 自定义输出目录（可选）
    created_at INTEGER DEFAULT (unixepoch())
);

-- 直播会话（一场直播或一次导入）
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    session_type TEXT DEFAULT 'live',  -- live / import
    title TEXT,                        -- 直播标题（自动抓取）
    start_time INTEGER,                -- 开播时间
    end_time INTEGER,                  -- 下播时间
    status TEXT DEFAULT 'recording',   -- recording / processing / completed / error
    total_duration INTEGER,            -- 总时长（秒）
    total_size INTEGER,                -- 总文件大小（字节）
    created_at INTEGER DEFAULT (unixepoch())
);

-- 媒体分段（录制自动分段或导入文件）
CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    file_path TEXT NOT NULL,           -- 视频文件绝对路径
    start_offset INTEGER,              -- 在整场直播中的起始时间（秒）
    duration INTEGER,                  -- 本段时长（秒）
    size INTEGER,                      -- 文件大小
    has_danmaku BOOLEAN DEFAULT 0,     -- 是否有弹幕文件
    danmaku_path TEXT,                 -- 弹幕文件路径
    status TEXT DEFAULT 'pending',     -- pending / transcribing / analyzing / ready / error
    created_at INTEGER DEFAULT (unixepoch())
);

-- 转写结果（按词级存储，精度高）
CREATE TABLE transcripts (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER REFERENCES segments(id),
    language TEXT DEFAULT 'zh',
    full_text TEXT,                    -- 完整文本（搜索用）
    -- 词级时间戳 JSON: [{"word": "hello", "start": 0.5, "end": 0.8}]
    words_json TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 弹幕事件（标准化后）
CREATE TABLE danmaku_events (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER REFERENCES segments(id),
    event_type TEXT,                   -- danmaku / super_chat / gift / guard
    timestamp_ms INTEGER,              -- 在分段内的时间戳（毫秒）
    text TEXT,                         -- 弹幕内容或礼物名
    user_id TEXT,
    price INTEGER DEFAULT 0,           -- 金额（分），普通弹幕为 0
    created_at INTEGER DEFAULT (unixepoch())
);

-- 候选片段（AI 生成，人工审核）
CREATE TABLE candidates (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    segment_id INTEGER REFERENCES segments(id),
    -- 时间戳（相对于 session 全局）
    start_time INTEGER,
    end_time INTEGER,
    duration INTEGER,                  -- 时长（秒）
    -- 评分因子（可解释）
    score_total REAL,                  -- 总分 0-100
    score_danmaku REAL,                -- 弹幕密度分
    score_interaction REAL,            -- SC/礼物分
    score_transcript REAL,             -- 转写关键词分
    score_energy REAL,                 -- 声音能量/语速分
    -- AI 分析结果
    ai_summary TEXT,                   -- 内容摘要（一句话）
    ai_title_suggestion TEXT,          -- 推荐标题
    ai_reason TEXT,                    -- 推荐理由
    -- 人工审核
    status TEXT DEFAULT 'pending',     -- pending / approved / rejected
    user_note TEXT,                    -- 用户备注
    created_at INTEGER DEFAULT (unixepoch())
);

-- 导出任务
CREATE TABLE exports (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    candidate_ids TEXT,                -- JSON 数组，支持合并多个片段
    output_path TEXT,                  -- 导出文件路径
    options_json TEXT,                 -- 导出配置（字幕开关、画质等）
    status TEXT DEFAULT 'pending',     -- pending / processing / completed / error
    progress INTEGER DEFAULT 0,        -- 0-100
    error_msg TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 系统配置（LLM/ASR/账号）
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);
```

---

## 核心流程

### 1. 录制流程

```
添加房间号 + Cookie
    ↓
后台启动 bililive-tools 录制器
    ↓
开播自动录制 → 分段落盘（按 30 分钟或 1GB 分段）
    ↓
触发 videoFileCompleted 事件
    ↓
后端入库（创建 segment 记录，status=pending）
    ↓
自动入队 ASR 任务
```

**关键设计**：

- 分段策略：固定 30 分钟或 1GB，先落盘再分析，避免丢数据
- 弹幕：同时保存 XML/JSON，解析后入库 `danmaku_events` 方便查询
- 故障恢复：重启后扫描 `library/sources/` 目录，恢复未完成的 session

### 2. ASR 流程（CPU 优化版）

```
segment 入队（status=transcribing）
    ↓
FFmpeg 抽取音频：16kHz mono wav（减小 Whisper 负担）
    ↓
调用 Python ASR Worker（本机 HTTP）
    ↓
faster-whisper small 模型，CPU int8 量化
    ↓
返回词级时间戳 → 入库 transcripts
    ↓
触发分析任务（status=analyzing）
```

**性能预期**：

- 模型：`small`（466MB 下载）
- 内存：峰值 2GB（16GB 机器安全）
- 速度：0.3x-0.5x 实时（1 小时录播需 2-3 小时转写）
- 队列：单线程顺序处理，避免内存爆炸

**模型配置**：

```python
# services/asr-worker/config.py
MODEL_SIZE = "small"           # 质量与速度平衡
DEVICE = "cpu"
COMPUTE_TYPE = "int8"          # 内存友好
BEAM_SIZE = 5                  # 默认即可
VAD_FILTER = True              # 过滤静音，加速处理
```

### 3. 候选生成流程（规则评分 + 轻量 LLM）

**第一阶段：规则评分**（本地计算，无成本）

```python
def calculate_candidate_score(segment, window_start, window_end):
    """
    滑动窗口评分，窗口 45-120s，步长 15s
    返回 0-100 分
    """
    score = 0

    # 1. 弹幕密度（40 分）
    danmaku_count = count_events('danmaku', window_start, window_end)
    score += min(40, danmaku_count / 10 * 40)  # 每 10 条弹幕得满分

    # 2. 付费互动（30 分）
    sc_total = sum(e.price for e in events if e.type == 'super_chat')
    score += min(30, sc_total / 1000 * 30)  # 10 元 SC 得满分

    # 3. 转写关键词（20 分）
    keywords = ['666', 'nb', '泪目', '爆笑', '高能', '救命']
    hits = count_keyword_matches(transcript, keywords)
    score += min(20, hits * 5)

    # 4. 声音能量（10 分）
    # 从 FFmpeg 提取音量峰值（预处理）
    volume_peak = get_volume_peak(window_start, window_end)
    score += min(10, volume_peak / -20 * 10)  # -20dB 以上得满分

    return score
```

**第二阶段：LLM 摘要**（轻量调用，降低成本）

只针对规则评分 > 70 分的片段调用 LLM：

```typescript
const prompt = `
你是一个直播切片助手。请根据以下信息，为这个候选片段生成一句话摘要和一个吸引人的标题建议。

片段信息：
- 时长：${duration}秒
- 弹幕数：${danmakuCount}
- SC金额：${scTotal}元
- 转写文本：${transcriptText.slice(0, 500)}

请用 JSON 格式返回：
{
  "summary": "一句话描述这个片段发生了什么（20字以内）",
  "title": "适合B站投稿的标题（带emoji，30字以内）",
  "reason": "为什么这个片段值得切（从观众角度）"
}
`;
```

**LLM 配置**（用户填一次）：

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini",
  "maxTokens": 200
}
```

**产出**：每个候选片段有 5 个维度分数 + AI 一句话总结 + 推荐标题

### 4. 审核与导出流程

```
用户打开 Session 页
    ↓
查看候选卡片列表（分数倒序）
    ↓
点击播放预览（生成低码率预览代理）
    ↓
勾选想要的片段 → 批准
驳回不想要的 → 拒绝（可选填原因）
    ↓
进入导出页
    ↓
配置选项：
  - 合并相邻片段（开关）
  - 硬字幕/软字幕（开关）
  - 弹幕烧录（开关）
  - 画质：原画/1080p/720p
    ↓
一键导出 → 后台 FFmpeg 渲染
    ↓
生成：MP4 + SRT + clip_info.json
```

**导出产物**：

- `20250419_直播标题_片段1.mp4` - 视频文件
- `20250419_直播标题_片段1.srt` - 字幕文件（可用剪映识别样式）
- `20250419_直播标题_片段1.json` - 片段元数据（含标题建议、时间戳）

**投稿辅助**（不做自动上传）：

- 界面显示推荐的标题、标签、简介
- 一键复制到剪贴板
- 提供 B站投稿页快捷打开

---

## API 设计（REST + SSE）

### REST 端点

```typescript
// 直播源管理
GET    /api/sources              // 列表
POST   /api/sources              // 添加：{ roomId, cookie }
DELETE /api/sources/:id          // 删除
PATCH  /api/sources/:id          // 更新 Cookie

// 会话查询
GET    /api/sessions             // 列表（支持分页、状态过滤）
GET    /api/sessions/:id         // 详情（含 segments）
GET    /api/sessions/:id/stats   // 统计：总时长、转写进度、候选数量

// 候选片段
GET    /api/sessions/:id/candidates           // 列表（支持状态过滤）
POST   /api/candidates/:id/approve             // 批准
POST   /api/candidates/:id/reject              // 驳回：{ reason? }
GET    /api/candidates/:id/preview.mp4         // 低码率预览（动态生成）

// 导出
POST   /api/exports                          // 创建导出任务
GET    /api/exports/:id/progress             // 查询进度
GET    /api/exports/:id/download             // 下载成品

// 系统
GET    /api/system/status                    // 运行状态：录制中/转写队列/磁盘空间
GET    /api/system/settings                  // 获取配置
POST   /api/system/settings                  // 更新配置（LLM/ASR）
POST   /api/system/retry/:taskId              // 重试失败任务
```

### SSE 实时事件

```typescript
// 连接：GET /api/events/stream

event: recorder.status
data: { sourceId, roomId, status: 'recording' | 'stopped' | 'error', currentFile? }

event: segment.created
data: { segmentId, sessionId, filePath, duration }

event: segment.transcription_progress
data: { segmentId, progress: 0-100 }

event: segment.transcription_completed
data: { segmentId, transcriptId, language }

event: candidates.generated
data: { sessionId, count, topCandidates: [...] }

event: export.progress
data: { exportId, progress: 0-100, eta? }

event: export.completed
data: { exportId, outputPath }

event: system.alert
data: { level: 'warning' | 'error', message, suggestion? }
```

---

## 界面设计（高信息密度控制台）

### 页面结构

```
┌─────────────────────────────────────────────────────────────┐
│  AICut                                    [录制中] [设置] │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│  导航    │                  主内容区                        │
│          │                                                  │
│  总览  │  ┌──────────────────────────────────────────┐   │
│  直播源 │  │  Session: 2025-04-19 主播名 直播标题      │   │
│  会话  │  │  [播放全场] [刷新] [导出选中]              │   │
│  候选  │  └──────────────────────────────────────────┘   │
│  导出  │                                                  │
│          │  ┌──────────────────────────────────────────┐   │
│  ───────  │  │  时间轴（转写文本 + 弹幕热度 + 候选标记）   │   │
│          │  └──────────────────────────────────────────┘   │
│  设置    │                                                  │
│          │  ┌──────────────────────────────────────────┐   │
│          │  │  候选片段卡片列表（分数倒序）              │   │
│          │  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐            │   │
│          │  │  │ 92 │ │ 88 │ │ 85 │ │ 79 │ ...         │   │
│          │  │  └────┘ └────┘ └────┘ └────┘            │   │
│          │  └──────────────────────────────────────────┘   │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

### 候选片段卡片

```
┌────────────────────────────────────────┐
│ [缩略图]  00:23:45 - 00:25:10 (85秒)    │
│         ━━━━━━━━━━━━━━━━━━━━━━         │
│                                        │
│  总分: 92  │  弹幕:38  SC:¥12  高能    │
│                                        │
│  "主播单杀大龙，弹幕狂刷666"            │
│  💡 推荐标题：丝滑操作！这波单杀什么水平 │
│                                        │
│  [👁️ 预览] [✅ 要] [❌ 不要]           │
└────────────────────────────────────────┘
```

### 时间轴组件

```
时间: 00:00 ─────── 00:30:00 ─────── 01:00:00
      ├─[转写文本自适应高度]──────────────┤
      ▓▓░░▓▓▓░░░▓▓▓▓░░▓░░░  [弹幕热度]
         ↑    ↑       ↑
        [█]  [█]     [█]     ← 候选标记（颜色=分数）
       92分  88分    76分
      ─────┬─────────
           │ 选中高亮区域
    ┌──────┴──────┐
    │ 转写文本详情 │
    │ 弹幕列表    │
    │ [批准][驳回]│
    └─────────────┘
```

---

## 实施阶段（调整后的优先级）

### Phase 1：录制 + 导入 + ASR（核心骨架）

**目标**：能录、能转、能看到转写文本

- [ ] 项目初始化：monorepo、TypeScript、tailwind
- [ ] SQLite 数据库初始化
- [ ] 环境检测脚本：FFmpeg、Python、模型下载
- [ ] 启动脚本：`npm run dev` 同时起 Node + Python
- [ ] bililive-tools 录制器接入：
  - 添加房间号 + Cookie
  - 分段录制事件监听
  - 弹幕保存
- [ ] Python ASR Worker：
  - FastAPI HTTP 服务
  - small 模型加载
  - 转写接口 `/transcribe`
- [ ] 转写任务队列：
  - segment 入库触发
  - 单队列顺序处理
  - 进度更新到 SSE
- [ ] Web 界面：
  - 直播源管理页
  - 会话列表页
  - 分段详情页（含转写文本）

**验收标准**：

- 能添加 B站房间并开始录制
- 分段完成后自动转写
- 界面上能看到转写文本

---

### Phase 2：候选生成 + 审核 + 导出（完成闭环）

**目标**：能生成候选、能勾选导出

- [ ] 弹幕标准化入库
- [ ] 规则评分实现（弹幕密度、SC、关键词、音量）
- [ ] LLM 摘要调用（仅高分片段）
- [ ] 候选生成任务编排
- [ ] 候选列表页（卡片式）
- [ ] 播放器组件：
  - 视频播放
  - 时间轴（转写 + 弹幕 + 候选标记）
  - 片段预览（动态截取）
- [ ] 审核功能：批准/驳回
- [ ] 导出功能：
  - 多选候选
  - FFmpeg 合并渲染
  - 字幕/弹幕烧录选项
  - 进度显示

**验收标准**：

- 转写完成后自动出现候选片段
- 能播放预览、勾选导出
- 导出文件可用剪映打开精修

---

### Phase 3： polish + 投稿辅助（体验优化）

**目标**：好用、稳定、省时间

- [ ] 设置页：
  - LLM 配置（API Key、模型选择）
  - ASR 配置（模型切换 small/base）
  - 录制配置（分段时长、画质）
- [ ] 磁盘管理：
  - 自动清理旧录制（保留 7 天/30 天选项）
  - 一键清理已导出的源文件
- [ ] 任务失败重试机制
- [ ] 重启恢复：未完成任务自动继续
- [ ] 投稿辅助：
  - 标题/标签/简介生成
  - 一键复制
  - B站投稿页快捷打开
- [ ] 健康检查与提示：
  - Cookie 过期检测
  - 磁盘空间不足预警
  - 长时间未生成候选提示

**验收标准**：

- 配置一次后长期自动运行
- 导出后能快速投稿
- 异常情况有明确提示

---

## 性能与资源预算

| 场景     | 内存占用 | CPU 占用 | 说明                     |
| -------- | -------- | -------- | ------------------------ |
| 空闲后台 | ~200MB   | <5%      | Node + SQLite + 录制监听 |
| 录制中   | ~500MB   | 10-20%   | FFmpeg 编码              |
| ASR 转写 | ~2.5GB   | 80-100%  | Python + Whisper small   |
| 导出渲染 | ~1GB     | 50-80%   | FFmpeg 编码              |

**16GB 内存安全策略**：

- ASR 单队列：绝不并行处理多个分段
- 转写时暂停其他非关键任务
- 大文件分段转写（超过 30 分钟强制拆分）

---

## 关键依赖与许可

| 依赖           | 许可     | 使用方式       | 风险                 |
| -------------- | -------- | -------------- | -------------------- |
| bililive-tools | MIT      | npm 依赖       | 低                   |
| faster-whisper | MIT      | Python pip     | 低                   |
| FFmpeg         | LGPL/GPL | 外部可执行文件 | 中（需确认编译选项） |
| 模型 (small)   | OpenAI   | 本地权重文件   | 低                   |

**建议**：FFmpeg 使用 LGPL 编译版本，避免 GPL 传染。

---

## 一键启动命令

```bash
# 开发模式
npm run dev
# 1. 检测 FFmpeg、Python 环境
# 2. 自动下载 small 模型（如不存在）
# 3. 启动 Python ASR Worker（http://localhost:8000）
# 4. 启动 Node API（http://localhost:3000）
# 5. 启动 React Web（http://localhost:5173）

# 生产模式（Windows）
npm run build
npm run start
# 后台常驻，浏览器访问 http://localhost:3000
```

---

## 与参考项目的关系

| 功能     | 参考项目                                 | 本方案使用方式                     |
| -------- | ---------------------------------------- | ---------------------------------- |
| B站录制  | bililive-tools, biliup, bililive-go      | 直接依赖 `@bililive-tools/manager` |
| ASR      | VideoCaptioner, bcut-asr, faster-whisper | 自建 Python Worker，参考配置方式   |
| B站接口  | bilibili-api, bilibili-API-collect       | 阅读源码理解接口，不直接依赖       |
| 弹幕处理 | biliLive-tools, danmakus-client          | 参考 XML/JSON 解析逻辑             |
| 候选生成 | bilive                                   | 参考 Pipeline 设计，简化实现       |
| 架构     | cc-switch                                | 参考 Tauri 桌面应用（V2 可选）     |

**原则**：优先通过 npm/pip 依赖复用，避免复制 GPL 代码进核心仓库。
