# AICut

AICut 是一个面向个人切片师的本机 Web 工具，目标是把 B 站直播录制后的处理流程压缩为：

`录制 -> 自动转写/分析 -> 人工勾选 -> 导出粗剪`

当前仓库已按 `AICut-V1-方案.md` 初始化为三端结构：

- `apps/api`：Fastify + SQLite 本地后端
- `apps/web`：React + Vite 控制台
- `services/asr-worker`：Python FastAPI ASR worker

## 配置文件

配置文件位于 `config/` 目录（已加入 gitignore）：

- `config/keywords.json` - 评分关键词配置（正向/负向关键词、分值、分类、别名）
- `config/prompts.json` - LLM 提示词配置（系统提示词、用户模板、任务级参数）
- `config/cookie.json` - B站 Cookie 配置（录制登录态）

首次使用需创建 `config/cookie.json`，可参考 `config/cookie.example.json`。

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
