# AICut

AICut 是一个面向个人切片师的本机 Web 工具，目标是把 B 站直播录制后的处理流程压缩为：

`录制 -> 自动转写/分析 -> 人工勾选 -> 导出粗剪`

## 项目结构

```
apps/api          # Fastify + SQLite 本地后端
apps/web          # React + Vite 控制台
```

## 配置文件

配置文件位于 `config/` 目录（已加入 gitignore）：

| 文件 | 说明 |
|------|------|
| `keywords.json` | 评分关键词配置（正向/负向关键词、分值、分类、别名） |
| `prompts.json` | LLM 提示词配置（系统提示词、用户模板、任务级参数） |
| `cookie.json` | B站 Cookie 配置（录制登录态） |

首次使用需创建 `config/cookie.json`，可参考 `config/cookie.example.json`。

## 开发启动

### 合并启动

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
