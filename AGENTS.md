# AGENTS.md

AICut 项目的 AI 助手上下文索引。

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/design-context.md](docs/design-context.md) | 设计上下文：用户画像、品牌调性、美学方向、设计原则 |
| [docs/AICut-V1-方案.md](docs/AICut-V1-方案.md) | 项目完整方案：阶段规划、数据模型、API 设计、UI 原型 |
| [docs/scoring-algorithm.md](docs/scoring-algorithm.md) | 评分算法：动态阈值、维度权重、LLM 增强 |
| [AICut V2 重构计划文档.md](AICut%20V2%20重构计划文档.md) | V2 重构计划：流式 ASR、HLS DVR、SenseVoice |

## 设计上下文概要

### 用户画像
本地 Windows 环境下的个人 B 站切片师，需要监控录制、审阅候选、快速决策、导出粗剪。

### 品牌调性
专业、专注、工具化。UI 应像一个紧凑的导播控制室，而非休闲浏览型 SaaS。

### 美学方向
高密度控制台美学，强层次，暖色信号，清晰状态指示。避免紫蓝渐变、玻璃态、吉祥物、过度装饰。

### 设计原则
- 审阅效率优先：候选质量、原因、时间戳、操作一目了然
- 状态显式化：录制、转写、分析、导出、错误各有视觉语言
- 控件与媒体上下文紧密：播放器、弹幕、审批控件视觉关联
- 克制的动效与色彩：只在影响决策处强调状态变化
- 长时操作舒适：可读字体、强对比、稳定布局、低视觉疲劳

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装 Node 依赖。 |
| `pnpm check:env` | 检查 node、pnpm、python、ffmpeg 是否可用，并创建 `library/` 目录结构。 |
| `pnpm dev` | 合并启动：同时运行 API、Web 和 ASR Worker。 |
| `pnpm dev:split` | 分窗口启动：在独立 PowerShell 窗口中运行各服务。 |
| `pnpm dev:api` | 单独启动 API（Fastify，http://127.0.0.1:43110）。 |
| `pnpm dev:web` | 单独启动 Web（Vite，http://127.0.0.1:43111），代理 `/api` 到后端。 |
| `pnpm dev:asr` | 单独启动 ASR Worker（Python FastAPI，http://127.0.0.1:43112）。 |
| `pnpm build` | 构建所有 apps。 |
| `pnpm typecheck` | 全仓库 TypeScript 类型检查（`--noEmit`）。 |
| `pnpm lint` | 全仓库 lint（目前等同于 `typecheck`）。 |
| `pnpm format` | Prettier 格式化全仓库。 |
| `cd services/asr-worker && python -m venv .venv && .\.venv\Scripts\pip install -r requirements.txt` | 安装 Python ASR 依赖。 |

## 架构概览

AICut 是一个面向 B 站直播切片场景的本地优先 monorepo。包含三个服务：`apps/api`（Fastify + SQLite）、`apps/web`（React + Vite）、`services/asr-worker`（Python FastAPI + SenseVoice）。开发时三服务跑在本地 43110–43112 端口。

### apps/api

Node.js 22+，使用原生 `node:sqlite`（`DatabaseSync`），无 ORM。`db/index.ts` 提供 `getDb()`、`row()`、`rows()` 三个辅助函数；`db/schema.sql` 在启动时自动执行，启用 WAL 和外键。没有迁移机制，大版本重构需要重建数据库。

配置集中在 `config.ts`，从环境变量读取并带默认值：
- `AICUT_API_HOST` / `AICUT_API_PORT`（默认 127.0.0.1:43110）
- `AICUT_DB_PATH` / `AICUT_LIBRARY_ROOT`
- `AICUT_ASR_WORKER_URL`（默认 http://127.0.0.1:43112）
- `AICUT_FFMPEG_PATH` / `AICUT_RECORDER_SEGMENT`
- `AICUT_PYTHON`（用于启动 ASR Worker）

核心模块位于 `src/core/`：

- **recorder/** — 封装 `@bililive-tools/manager` 与 `@bililive-tools/bilibili-recorder` 实现 B 站录制。输出格式固定为 TS，分段时长 2 分钟（`segment="2"`）。内部维护多组 Map（source→recorder→session→runtime），启动时自动恢复 `auto_record=1` 的源。Cookie 支持原始字符串、JSON 数组/对象、以及 `config/cookie.json` 三种形式。
- **hls/** — 动态 m3u8 生成器。`manifest.ts` 在内存中维护 session 的 segment 列表；录制过程中追加 `#EXTINF`，录制结束后追加 `#EXT-X-ENDLIST`。TS 文件不经转码直接通过 `/api/sessions/:id/hls/:segmentId.ts` 流式返回。
- **asr/** — `streamClient.ts` 负责与 Python ASR Worker 的 HTTP+SSE 通信。录制开始时启动流式识别，实时缓存 transcript chunks；录制结束时停止流，合并缓存与最终结果，去重排序后写入 `transcripts` 表。
- **bilibili/** — 调用 bililive-tools 的 `getStream()` 获取音频-only 流地址，供 ASR Worker 使用。
- **danmaku/** — 解析 bililive-tools 生成的弹幕 sidecar 文件，导入 `danmaku_events` 表。
- **analysis/** — 候选评分流水线。`stats.ts` 计算 session 级别的弹幕/互动/能量分位数；`keywords.ts` 加载 `config/keywords.json`；`rules.ts` 按能量、弹幕密度、互动金额、转写关键词等维度计算规则分；`llm.ts` 可选接入 LLM 进行增强评分；`scoring.ts` 在转写完成后触发窗口生成与候选创建。
- **export/** — 基于 FFmpeg 的粗剪导出。支持单片段裁剪与多片段 concat，带进度回调；同时按候选时间范围过滤生成 SRT 字幕，以及低码率预览图。
- **library/** — 定义 `library/` 下的标准目录结构（sources、transcripts、candidates、exports）。

`events/bus.ts` 是一个简单的 EventEmitter，所有内部模块通过它发布事件。`eventsRoutes` 将事件以 SSE 形式暴露为 `/api/events/stream`，带 15 秒心跳。前端 `hooks/useEventStream.ts` 消费该流。

路由位于 `src/routes/`，在 `src/index.ts` 中注册：sources、sessions、candidates、exports、settings、events、hls。输入校验统一使用 Zod。

### apps/web

React 19 + Vite + TailwindCSS。Vite 开发服务器将 `/api` 代理到后端。视频播放使用 `@vidstack/react` + `hls.js`，支持 HLS DVR 模式与实时回退。

`api/client.ts` 提供 `apiGet` / `apiPost` / `apiPatch` 三个轻量 fetch 封装。页面包括 Dashboard、Sources、Sessions、LiveMonitor、Review、Exports、Settings，通过 `SystemRail` 侧边栏切换导航。

UI 遵循高密度控制台美学：强层级、暖色信号、清晰状态指示，避免紫蓝渐变与玻璃态。具体原则与配色参考 `docs/design-context.md`。

### services/asr-worker

Python FastAPI 服务，基于 SenseVoice-Small（FunASR）实现中/英/日自动语音识别。默认 CPU int8 推理。

`main.py` 暴露 `/health`、文件模式 `/transcribe`、以及流式接口 `/stream/start`、`/stream/stop`、`/stream/{id}/events`（SSE）。`stream_worker.py` 通过 FFmpeg 拉取音频流（16kHz mono s16 PCM），经 webrtcvad 做语音活动检测后送入 SenseVoice，并计算漂移校准后的全局时间戳（以 session 开始时刻为 0 秒）。`stream_manager.py` 管理多流并发与监听器注册。`sensevoice_worker.py` 维护模型单例与文件级转写。

### 典型数据流

1. 用户在 Sources 创建 B 站 `room_id` 并启动监控；`recorderManager` 开始录制 TS 分段到 `library/sources/`。
2. `RecordStart` 触发创建 `Session`，同时 API 获取音频流地址并启动 ASR Worker 的流式识别。
3. ASR Worker 通过 SSE 实时推送 transcript chunks；API 缓存并经由 EventBus 推送给前端。
4. `RecordStop` 时停止 ASR 流，合并缓存与最终 segments，去重后写入 `transcripts` 表（session 级）。
5. 转写完成触发 `tryGenerateCandidates`，计算 stats、规则分、可选 LLM 分，写入 `candidates`。
6. Review 页面展示候选，用户审批后状态变为 `approved`/`rejected`。
7. Exports 创建导出任务，`processExportTask` 用 FFmpeg 拼接 approved 片段，并按候选时间范围过滤生成 SRT。

### 关键设计决策

- SQLite 在启动时自动执行 schema.sql，无迁移脚本；schema 变更需要重建数据库（V2 已不兼容 V1 数据）。
- ASR 以 session 为粒度做流式识别，segment 仅作为视频文件存在，不再承担 ASR 状态追踪职责。
- HLS 服务零转封装：录制生成的 `.ts` 文件直接进 m3u8 playlist。
- 转写时间戳采用全局秒（从 session 开始起算），已做 ASR 启动漂移校准，可与播放器 `currentTime` 直接对应。
- EventBus 是内部实时状态变更的唯一通道，前端通过统一 SSE 端点订阅全部事件。
