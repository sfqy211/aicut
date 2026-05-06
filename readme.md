# AICut

AICut 是一个面向个人切片师的本机 Web 工具，目标是把 B 站直播录制后的处理流程压缩为：

`录制 -> 自动转写/AI分析 -> 人工勾选 -> 导出粗剪`

## 项目结构

```
apps/api          # Fastify + SQLite 本地后端
apps/web          # React + Vite 控制台
bin/              # ffmpeg + ffprobe
```

## 配置

所有配置通过 Settings 页面管理，存入 SQLite `settings` 表：

- **LLM 配置**：API URL、API Key、模型名（默认 MiMo v2.5 Pro）
- **ASR 配置**：火山引擎 API Key、Resource ID
- **B站账号**：扫码登录，自动保存 Cookie

## 开发启动

```powershell
pnpm install
pnpm check:env
pnpm dev
```

### 分窗口启动

```powershell
pnpm dev:split

# 或单独启动
pnpm dev:api   # API 服务 (http://127.0.0.1:43110)
pnpm dev:web   # Web 服务 (http://127.0.0.1:43111)
```
