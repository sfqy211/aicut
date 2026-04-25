---

# AICut V2 重构计划文档
## 整场直播流式 ASR + DVR 回看

**文档版本**：1.0  
**日期**：2025-04-25  
**状态**：待实施

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端 (React + vidstack)                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ LiveMonitor 页面                                         │   │
│  │ ┌──────────────────┐  ┌──────────────────────────────┐ │   │
│  │ │ vidstack Player  │  │ 实时字幕                      │ │   │
│  │ │ (HLS provider)   │  │ 聊天式滚动 + 时间戳            │ │   │
│  │ │ DVR 时间轴       │  │ [01:23] 欢迎来到直播间        │ │   │
│  │ │ 可 seek 回退     │  │ [01:28] 今天玩个新游戏        │ │   │
│  │ │ "回到最新"按钮   │  │ [01:35] 先看下装备 (Partial)  │ │   │
│  │ └──────────────────┘  └──────────────────────────────┘ │   │
│  │ ┌─────────────────────────────────────────────────────┐ │   │
│  │ │ 进度条: [━━━━●━━━━━━━━━━━━━━━━━━━━] 01:35 / 03:20:00│ │   │
│  │ │ (可拖动回退，点击跳转到对应字幕)                      │ │   │
│  │ └─────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌─────────────┐    ┌─────────────────┐    ┌──────────────┐
│ HLS 播放列表 │    │ 字幕查询 API     │    │ SSE 实时字幕  │
│ /api/sess-  │    │ /api/sessions/   │    │ /api/events  │
│ ions/:id/   │    │ :id/transcript   │    │ /stream      │
│ playlist.m3u8│   └─────────────────┘    └──────────────┘
└─────────────┘                   │
        │                         │
        ▼                         ▼
┌─────────────────────────────────────────────────────────────┐
│                        API 层 (Fastify)                      │
│  ┌─────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ m3u8 生成器 │  │ ASR StreamClient│  │ EventBus        │ │
│  │ (动态生成   │  │ (start/stop/    │  │ (SSE 广播)      │ │
│  │  playlist)  │  │  SSE 消费)      │  │                 │ │
│  └─────────────┘  └─────────────────┘  └──────────────────┘ │
│         │                   │                   │            │
│  bililive-tools           @bililive-tools/      │            │
│  (录制 TS 分段)            bilibili-recorder      │            │
│  segment=2分钟            getStream()           │            │
│  videoFormat="ts"          (onlyAudio: true)    │            │
│                                 │                │            │
│                                 ▼                │            │
│                          ┌──────────────┐       │            │
│                          │ ASR Worker   │       │            │
│                          │ SenseVoice   │───────┘            │
│                          │ 流式识别     │  SSE 推送            │
│                          └──────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、核心设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| ASR 引擎 | SenseVoice-Small (FunASR) | 中/英/日 auto，CPU int8，本地化 |
| 流式模式 | 独立拉音频-only 流 | 不修改 bililive-tools，零侵入 |
| 同步方案 | 系统时钟 + 漂移校准 | 后端透明校准，前端无感知 |
| 播放器 | vidstack@next (hls.js) | 原生支持 `live:dvr` + EVENT 模式 |
| HLS 后端 | 动态 m3u8（零转封装） | 学习 bili-shadowreplay，直接读取录制文件 |
| 录制格式 | TS | 兼容 HLS，无需转封装 |
| Segment 时长 | 2 分钟 | 平衡延迟与识别准确率 |
| 旧数据兼容 | 不兼容 | 重建数据库 |

---

## 三、时间对齐机制（核心）

### 系统时钟基准

```
T+0: RecordStart 触发
     sessionStartTime = Date.now()  // 统一基准
     
     bililive-tools 开始录制 TS 文件
     ├─ segment_001.ts (start_offset=0)
     ├─ segment_002.ts (start_offset=120)
     └─ ...
     
     ASR Worker 启动（可能晚 1-3 秒）
     asrStartTime = Date.now()
     driftMs = asrStartTime - sessionStartTime  // 漂移校准值

ASR 识别结果时间戳：
  rawStart = (currentTime - sessionStartTime) / 1000 - bufferDuration
  calibratedStart = rawStart - (driftMs / 1000)  // 对齐视频
  calibratedEnd = rawEnd - (driftMs / 1000)
  
  → 全局时间戳，与 player.currentTime 直接匹配
```

### 前端查询

```typescript
// 播放器时间 = 视频文件内部时间（从 0 开始）
const currentTime = player.currentTime;

// 后端已校准，直接查询
const subtitle = subtitleCache.find(s => 
  s.start <= currentTime && currentTime <= s.end
);
```

---

## 四、Phase 详细执行计划

### Phase 1: HLS 后端服务（m3u8 动态生成）

**目标**：将 bililive-tools 录制的 TS 文件实时生成 HLS m3u8 播放列表。

#### 1.1 修改 bililive-tools 录制配置

**文件**：`apps/api/src/core/recorder/recorderManager.ts`

| 变更项 | 当前值 | 新值 |
|--------|--------|------|
| `videoFormat` | `"auto"` | `"ts"` |
| `segment` | `"30"`（30分钟） | `"2"`（2分钟） |

#### 1.2 新建 m3u8 生成器模块

**文件**：`apps/api/src/core/hls/manifest.ts`

```typescript
// 维护 session 的 segment 列表
// 监听 videoFileCreated → 追加 segment
// 监听 RecordStop → 追加 #EXT-X-ENDLIST
// 生成 m3u8 文本：
//   #EXTM3U
//   #EXT-X-VERSION:6
//   #EXT-X-PLAYLIST-TYPE:EVENT
//   #EXT-X-TARGETDURATION:120
//   #EXTINF:120.000,
//   /api/sessions/:id/segments/:segmentId.ts
//   ...
```

**文件**：`apps/api/src/core/hls/routes.ts`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions/:id/hls/playlist.m3u8` | GET | 返回动态生成的 m3u8 |
| `/api/sessions/:id/hls/:segmentId.ts` | GET | 流式返回 TS 文件内容 |

**文件**：`apps/api/src/core/hls/index.ts`

```typescript
// 导出 HLS 服务和路由
// 注册 Fastify 路由
```

#### 1.3 注册 HLS 路由

**文件**：`apps/api/src/index.ts`

```typescript
import { hlsRoutes } from "./core/hls/index.js";
await app.register(hlsRoutes, { prefix: "/api" });
```

---

### Phase 2: ASR Worker 重构

**目标**：将 faster-whisper 替换为 SenseVoice-Small，实现流式识别。

#### 2.1 依赖替换

**文件**：`services/asr-worker/requirements.txt`

```
# 移除
# faster-whisper>=1.1.0

# 新增
funasr>=1.1.0
modelscope>=1.18.0
torch>=2.0.0
torchaudio>=2.0.0
librosa>=0.10.0
soundfile>=0.12.0
webrtcvad>=2.0.10
numpy>=1.24.0
```

#### 2.2 配置更新

**文件**：`services/asr-worker/config.py`

| 配置项 | 旧值 | 新值 |
|--------|------|------|
| `model` | `"small"` | `"iic/SenseVoiceSmall"` |
| `language` | `"zh"` | `"auto"` |
| `compute_type` | `"int8"` | 移除（FunASR 用 `load_in_8bit`） |
| `load_in_8bit` | 无 | `True` |
| `vad_sensitivity` | 无 | `2` |
| `chunk_duration_ms` | 无 | `60` |

#### 2.3 核心模块

**文件**：`services/asr-worker/sensevoice_worker.py`

```python
# 模型加载（单例）
# 音频预处理（librosa 加载）
# 语种标签去除（<|zh|>、<|en|>、<|ja|>）
# 文件模式 transcribe_file()
```

**文件**：`services/asr-worker/stream_worker.py`

```python
# FFmpeg 拉取音频流（16kHz mono s16 PCM）
# webrtcvad 语音活动检测
# SenseVoice 识别
# 全局时间戳计算（含 drift 校准）
# SSE 推送结果
```

**文件**：`services/asr-worker/stream_manager.py`

```python
# 多流管理（支持并发直播）
# 共享 SenseVoice 模型实例
# 监听者注册/注销
```

#### 2.4 FastAPI 服务

**文件**：`services/asr-worker/main.py`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 返回模型信息 |
| `/transcribe` | POST | 文件模式（保留） |
| `/stream/start` | POST | 启动流式识别 |
| `/stream/stop` | POST | 停止并返回完整结果 |
| `/stream/{id}/events` | GET (SSE) | 实时推送识别结果 |

---

### Phase 3: API 层集成

#### 3.1 B 站直播流地址获取

**文件**：`apps/api/src/core/bilibili/streamUrl.ts`

```typescript
// 封装 @bililive-tools/bilibili-recorder getStream()
// onlyAudio: true
// 返回音频-only 流 URL
```

#### 3.2 ASR 流式客户端

**文件**：`apps/api/src/core/asr/streamClient.ts`

```typescript
// startAsrStream(sessionId, streamUrl, sessionStartTimeMs)
//   - 计算 driftMs
//   - POST /stream/start
//   - 启动 SSE 消费
//
// stopAsrStream(sessionId)
//   - POST /stream/stop
//   - 返回完整 segments
//
// 内存字幕缓存（按 session）
// getTranscriptCache(sessionId)
```

#### 3.3 录制管理器集成

**文件**：`apps/api/src/core/recorder/recorderManager.ts`

**RecordStart 事件**：
1. 创建 session
2. 获取音频流地址
3. 启动 ASR 流

**RecordStop 事件**：
1. 停止 ASR 流
2. 获取完整 segments
3. 写入 `transcripts` 表（session 级）
4. 更新 session 状态 → `processing`
5. 触发 `tryGenerateCandidates`

#### 3.4 清理旧 ASR 逻辑

**文件**：`apps/api/src/core/asr/client.ts`

**删除**：
- `enqueueAsrTask`
- `processQueue`
- `restoreAsrQueue`
- `processSegment`
- 所有队列相关变量

**保留**：
- `transcribeFile`（文件模式备用）

#### 3.5 API 入口清理

**文件**：`apps/api/src/index.ts`

**删除**：
- `importsRoutes` 导入和注册
- `restoreAsrQueue` 调用

---

### Phase 4: 数据模型迁移

**文件**：`apps/api/src/db/schema.sql`

#### transcripts 表重构

```sql
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,  -- 新增，流式模式主键
  segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,  -- 可空，兼容未来导入
  language TEXT NOT NULL DEFAULT 'auto',
  full_text TEXT,
  words_json TEXT,
  segments_json TEXT,  -- [{start, end, text}, ...] 全局时间戳（秒）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_transcripts_session_id ON transcripts(session_id);
```

#### segments 表

保持不变。`status` 字段不再需要 ASR 状态（`pending`/`transcribing`/`ready`/`error`），仅用于视频处理状态。

---

### Phase 5: 前端 vidstack 集成与 LiveMonitor

#### 5.1 安装依赖

**文件**：`apps/web/package.json`

```json
{
  "dependencies": {
    "@vidstack/react": "^0.6.15",
    "vidstack": "^0.6.15"
  }
}
```

#### 5.2 类型定义

**文件**：`apps/web/src/types.ts`

```typescript
// 新增
export type LiveTranscriptChunk = {
  start: number;      // 全局时间（秒）
  end: number;
  text: string;
  isPartial: boolean;
};

export type SessionTranscript = {
  sessionId: number;
  segments: LiveTranscriptChunk[];
  status: "recording" | "completed" | "error";
};
```

#### 5.3 LiveMonitor 页面

**文件**：`apps/web/src/pages/LiveMonitor.tsx`

**布局**：
```
┌─────────────────────────────────────────────────────┐
│ LiveMonitor - Session #123                    [关闭] │
├──────────────────────────┬──────────────────────────┤
│                          │  实时字幕                │
│   vidstack Player        │  ─────────────────────   │
│   (HLS provider)         │  [01:23] 欢迎来到直播间  │
│   DVR 时间轴             │  [01:28] 今天玩个新游戏  │
│   可 seek 回退           │  [01:35] 先看下装备     │
│                          │  ...                     │
│                          │                          │
└──────────────────────────┴──────────────────────────┘
```

**状态机**：
- `liveMode`：播放最新内容，显示实时字幕气泡
- `reviewMode`：回退到历史时间点，隐藏实时气泡，显示历史字幕

**核心逻辑**：
```typescript
// 播放器 timeupdate 事件
const handleTimeUpdate = () => {
  const currentTime = player.currentTime;
  
  if (isLiveMode) {
    // 显示最新字幕 + 实时气泡
  } else {
    // 二分查找历史字幕
    const subtitle = findSubtitle(currentTime);
  }
};

// 点击"回到最新"
const handleBackToLive = () => {
  player.currentTime = player.seekableEnd - 5;
  setIsLiveMode(true);
};
```

#### 5.4 路由与导航

**文件**：`apps/web/src/App.tsx`

```typescript
// 新增 LiveMonitor 页面
// 从 Sessions 页面点击进入
```

**文件**：`apps/web/src/pages/Sessions.tsx`

```typescript
// 正在录制的 session 增加"监控"按钮
// 点击打开 LiveMonitor 覆盖层/弹窗
```

#### 5.5 事件监听

**文件**：`apps/web/src/hooks/useEventStream.ts`

**新增事件**：
- `session.transcription_live`：实时字幕推送
- `session.transcription_completed`：直播结束，转写完成
- `session.transcription_failed`：识别错误

---

### Phase 6: 分析与导出适配

#### 6.1 统计数据计算

**文件**：`apps/api/src/core/analysis/stats.ts`

```typescript
// computeSessionStats
// 修改：直接 WHERE session_id = ? 查询 transcripts
// 不再 JOIN segments
```

#### 6.2 候选生成

**文件**：`apps/api/src/core/analysis/scoring.ts`

```typescript
// findSegmentForWindow
// 全局时间范围 → 查询 segments 表 start_offset 覆盖范围
// 返回 segment_id（用于导出裁剪）
```

#### 6.3 导出与字幕

**文件**：`apps/api/src/core/export/ffmpeg.ts`

```typescript
// SRT 生成
// 从 session transcripts.segments_json 过滤候选时间范围
// start >= candidate.start_time && end <= candidate.end_time
```

---

### Phase 7: 删除导入功能 + 脚本/文档

#### 7.1 删除导入路由

**文件**：`apps/api/src/routes/imports.ts` → **删除**

**文件**：`apps/api/src/index.ts` → 移除 `importsRoutes` 导入和注册

#### 7.2 前端清理

**文件**：`apps/web/src/pages/Sessions.tsx`
- 移除 `session_type === "import"` 的 UI（"导入"标签）

**文件**：`apps/web/src/pages/Dashboard.tsx`
- 移除 import 类型 session 的统计

#### 7.3 脚本更新

**文件**：`scripts/download-model.js`
- 提示文案改为 SenseVoice（FunASR 自动下载）

**文件**：`scripts/start-dev.ps1`
- 移除 ASR Worker 默认 `AICUT_ASR_ALLOW_STUB=1`

**文件**：`scripts/dev-asr.js`
- 调整环境变量

#### 7.4 文档更新

**文件**：`docs/AICut-V1-方案.md`
- ASR 流程描述更新

**文件**：`AGENTS.md`
- ASR 相关说明更新

---

## 五、关键风险与应对

| 风险 | 影响 | 应对方案 |
|------|------|---------|
| **B 站 CDN URL 过期** | ASR Worker 断开 | V1 暂不处理。后续在 API 层定期刷新 URL 并重启 ASR 流 |
| **SenseVoice 线程安全** | 多流并发冲突 | FunASR `generate()` 理论线程安全。如遇问题，加 `threading.Lock` |
| **vidstack React 19 兼容性** | peer dep 警告 | 功能应正常。如遇运行时错误，降级 React 到 18 |
| **m3u8 动态更新** | hls.js 不刷新 | 确保 `#EXT-X-PLAYLIST-TYPE:EVENT` 且无 `#EXT-X-ENDLIST` |
| **实时字幕内存累积** | 长时间直播内存溢出 | 前端限制缓存最近 100 条，后端限制 SSE 连接数 |
| **segment 切换卡顿** | vidstack 播放不连续 | 2 分钟 segment + hls.js 预加载，切换应无感 |

---

## 六、测试验证清单

### Phase 1 验证
- [ ] bililive-tools 录制 TS 文件（2 分钟分段）
- [ ] `videoFileCreated` / `videoFileCompleted` 事件正常触发
- [ ] `/api/sessions/:id/hls/playlist.m3u8` 返回正确 m3u8
- [ ] vidstack 播放 m3u8，进入 `live:dvr` 模式
- [ ] 拖动时间轴可 seek 回退

### Phase 2 验证
- [ ] ASR Worker `/health` 返回 SenseVoice 信息
- [ ] `/stream/start` 成功启动流
- [ ] `/stream/{id}/events` SSE 实时推送识别结果
- [ ] 结果包含正确的时间戳和文本

### Phase 3 验证
- [ ] 启动录制 → ASR 流自动启动
- [ ] 直播期间 → EventBus 收到 `transcription_live` 事件
- [ ] 停止录制 → transcripts 表有 session 级记录
- [ ] 时间戳与视频时间轴对齐（误差 < 2 秒）

### Phase 4 验证
- [ ] `transcripts.segments_json` 格式正确
- [ ] 全局时间戳从 0 开始连续递增

### Phase 5 验证
- [ ] LiveMonitor 页面视频播放正常
- [ ] 实时字幕滚动同步
- [ ] 时间戳格式为相对时间（MM:SS）
- [ ] 点击时间轴 → 字幕滚动到对应位置
- [ ] "回到最新"按钮恢复正常实时模式
- [ ] 回放模式隐藏实时字幕气泡

### Phase 6 验证
- [ ] 候选生成成功（session 进入 `completed`）
- [ ] 导出 SRT 字幕时间戳与候选时间范围匹配

### Phase 7 验证
- [ ] 导入路由 404
- [ ] 无 import 类型 session 的 UI

---

## 七、实施顺序建议

```
Phase 1: HLS 后端服务
    ├─ 1.1 修改 bililive-tools 录制配置
    ├─ 1.2 新建 m3u8 生成器模块
    ├─ 1.3 注册 HLS 路由
    └─ 测试：vidstack 播放动态 m3u8，验证 DVR 模式

Phase 2: ASR Worker 重构
    ├─ 2.1 依赖替换
    ├─ 2.2 配置更新
    ├─ 2.3 sensevoice_worker.py（文件模式）
    ├─ 2.4 stream_worker.py（流式模式）
    ├─ 2.5 stream_manager.py（多流管理）
    ├─ 2.6 main.py（FastAPI 端点）
    └─ 测试：SSE 实时推送识别结果

Phase 3: API 层集成
    ├─ 3.1 bilibili/streamUrl.ts
    ├─ 3.2 asr/streamClient.ts
    ├─ 3.3 recorderManager.ts 集成
    ├─ 3.4 清理旧 ASR 逻辑
    ├─ 3.5 清理 API 入口
    └─ 测试：录制 → ASR 启动 → 字幕推送

Phase 4: 数据模型迁移
    ├─ 4.1 schema.sql 修改
    └─ 测试：RecordStop 时入库 transcripts

Phase 5: 前端 LiveMonitor
    ├─ 5.1 安装 vidstack
    ├─ 5.2 类型定义
    ├─ 5.3 LiveMonitor 页面
    ├─ 5.4 路由与导航
    ├─ 5.5 事件监听
    └─ 测试：视频 + 字幕同步 + seek 回退

Phase 6: 分析与导出适配
    ├─ 6.1 stats.ts
    ├─ 6.2 scoring.ts
    ├─ 6.3 export/ffmpeg.ts
    └─ 测试：候选生成 + SRT 导出

Phase 7: 清理
    ├─ 7.1 删除导入路由
    ├─ 7.2 前端清理
    ├─ 7.3 脚本更新
    ├─ 7.4 文档更新
    └─ 测试：无残留导入功能
```

---

## 八、最小可运行版本（MVP）

完成 **Phase 1 + Phase 2 + Phase 3 + Phase 4** 后，系统即可实现：
- 录制 TS 文件
- 实时流式识别
- 直播结束后入库 transcripts
- 触发候选生成

**Phase 5（前端 LiveMonitor）可以后续迭代**，不影响核心业务流程。

---

## 九、遗留问题

1. **vidstack React 19 peer dep 警告**：不需要降级 React
2. **Segment 时长最终确认**：2 分钟
3. **旧数据库迁移**：清空现有数据

请确认以上问题，或指示开始实施。