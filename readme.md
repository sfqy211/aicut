# AICut

AICut 是一个面向个人切片师的本机 Web 工具，目标是把 B 站直播录制后的处理流程压缩为：

`录制 -> 自动转写/分析 -> 人工勾选 -> 导出粗剪`

当前仓库已按 `AICut-V1-方案.md` 初始化为三端结构：

- `apps/api`：Fastify + SQLite 本地后端
- `apps/web`：React + Vite 控制台
- `services/asr-worker`：Python FastAPI ASR worker

## 开发启动

```powershell
pnpm install
pnpm check:env
pnpm dev
```

ASR worker 需要单独安装 Python 依赖：

```powershell
cd services/asr-worker
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## 当前阶段

第一阶段先提供可启动的工程骨架、SQLite schema、REST/SSE 基础接口和控制台页面。录制器、ASR 推理、LLM 重排和投稿能力将在此骨架上继续补齐。
