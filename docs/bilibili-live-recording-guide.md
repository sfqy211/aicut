# B站直播弹幕录制后台开发指南

本文档为开发大型弹幕、礼物等信息录制后台提供完整的技术参考，涵盖账号管理、API 连接、风控处理等核心主题。

---

## 目录

1. [账号认证体系](#1-账号认证体系)
2. [Cookie 管理策略](#2-cookie-管理策略)
3. [直播弹幕 WebSocket 协议](#3-直播弹幕-websocket-协议)
4. [WBI 签名机制](#4-wbi-签名机制)
5. [APP 签名机制](#5-app-签名机制)
6. [风控策略与规避](#6-风控策略与规避)
7. [消息类型与数据结构](#7-消息类型与数据结构)
8. [多房间并发架构](#8-多房间并发架构)
9. [关键 API 端点参考](#9-关键-api-端点参考)
10. [参考实现与资源](#10-参考实现与资源)

---

## 1. 账号认证体系

### 1.1 Cookie 体系总览

B站 Web 端认证基于 Cookie，关键 Cookie 如下：

| Cookie 名称 | 用途 | 获取方式 | 重要性 |
|-------------|------|----------|--------|
| `SESSDATA` | 一般 GET 请求的身份验证 | 登录后设置 | ⭐⭐⭐⭐⭐ 必需 |
| `bili_jct` | POST 请求的 CSRF Token | 登录后设置 | ⭐⭐⭐⭐⭐ 必需 |
| `DedeUserID` | 用户 MID (UID) | 登录后设置 | ⭐⭐⭐⭐ 重要 |
| `DedeUserID__ckMd5` | 用户 ID 校验 | 登录后设置 | ⭐⭐⭐ |
| `sid` | 会话 ID | 登录后设置 | ⭐⭐⭐ |
| `buvid3` | 设备指纹标识 | 网络请求生成 | ⭐⭐⭐⭐ 反爬关键 |
| `buvid4` | 设备指纹扩展 | 网络请求生成 | ⭐⭐⭐ 反爬关键 |
| `b_nut` | 设备标识 | 本地生成 | ⭐⭐⭐ |
| `b_lsid` | 会话标识 | 本地生成 | ⭐⭐ |
| `bili_ticket` | 风控票据 | 网络请求获取 | ⭐⭐⭐⭐ 风控关键 |
| `bili_ticket_expires` | 票据过期时间 | 随 bili_ticket 获取 | ⭐⭐⭐ |
| `ac_time_value` | 刷新令牌 (refresh_token) | 登录时获取 | ⭐⭐⭐⭐ 刷新必需 |

### 1.2 登录方式

#### 方式一：扫码登录（推荐）

```
流程:
1. GET /x/passport-login/web/qrcode/generate
   → 获取 qrcode_key + url

2. 生成二维码供用户扫描

3. GET /x/passport-login/web/qrcode/poll?qrcode_key=xxx
   → 轮询登录状态（建议 2 秒间隔，最多轮询 180 秒）
   → 成功后获取 Cookie: SESSDATA, bili_jct, DedeUserID 等
   → 同时获取 refresh_token (ac_time_value) 用于后续刷新
```

**关键 API：**
```
申请二维码: GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
轮询状态:   GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={qrcode_key}
```

**轮询响应状态码：**
| code | 含义 |
|------|------|
| 0 | 登录成功 |
| 86038 | 二维码已失效 |
| 86090 | 二维码已扫码未确认 |
| 86101 | 未扫码 |

#### 方式二：短信登录

```
发送验证码: POST https://passport.bilibili.com/x/passport-login/web/sms/send
验证登录:   POST https://passport.bilibili.com/x/passport-login/web/sms/check
```

#### 方式三：密码登录（需要极验验证码）

```
获取 hash 和公钥: GET https://passport.bilibili.com/x/passport-login/web/getKey
加密密码并提交:   POST https://passport.bilibili.com/x/passport-login/web/login
```

### 1.3 Credential 数据结构

```python
class Credential:
    """B站认证凭据"""
    sessdata: str        # 会话数据（核心认证令牌）
    bili_jct: str        # CSRF Token（POST 请求必需）
    buvid3: str          # 设备指纹标识
    buvid4: str          # 设备指纹扩展
    dedeuserid: str      # 用户 MID
    ac_time_value: str   # 刷新令牌（用于 Cookie 刷新）
    sid: str             # 会话 ID
```

---

## 2. Cookie 管理策略

### 2.1 Cookie 刷新机制

Web 端 Cookie 会随敏感接口访问逐渐失效，需要定期刷新：

```
刷新检查: GET https://passport.bilibili.com/x/passport-login/web/cookie/info

刷新步骤:
1. 生成 CorrespondPath:
   - 使用 RSA-OAEP 加密 "refresh_{timestamp}"
   - 公钥: MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg...

2. 获取 refresh_csrf:
   - GET https://www.bilibili.com/correspond/1/{correspondPath}
   - 从返回 HTML 中提取 refresh_csrf

3. 刷新 Cookie:
   - POST https://passport.bilibili.com/x/passport-login/web/cookie/refresh
   - 参数: csrf, refresh_csrf, refresh_token

4. 确认刷新:
   - POST https://passport.bilibili.com/x/passport-login/web/confirm/refresh
   - 参数: csrf, refresh_token
```

**刷新时机建议：**
- 定时刷新：每 6 小时检查一次
- 触发刷新：收到 `-401` 或 `99999` 错误码时
- 启动刷新：应用启动时验证 Cookie 有效性

### 2.2 多账号管理架构

```typescript
// 多 Cookie 源管理（参考 danmakus-client）
interface AuthManager {
  // Cookie 优先级：cookieCloud > local
  getPreferredCookie(): { source: AuthSourceKind; value: string } | null;
  
  // Cookie 验证（调用 /x/web-interface/nav）
  validateCookie(source: AuthSourceKind, cookie: string): Promise<boolean>;
  
  // 启动前检查
  ensureReadyForStartup(): Promise<void>;
}

// CookieCloud 同步
interface CookieManager {
  getCookies(): string;
  updateCookies(): Promise<void>;
  onChanged: () => void;  // 变更监听
  isSyncing(): boolean;
}
```

### 2.3 buvid 设备标识生成

buvid3/buvid4 是反爬的关键标识，需要正确生成：

```python
# buvid3 生成算法（简化版）
import uuid
import hashlib

def generate_buvid3():
    """生成 buvid3 设备指纹"""
    # 1. 生成 UUID
    raw_uuid = str(uuid.uuid4())
    
    # 2. 浏览器指纹（可简化为随机值）
    fingerprint = hashlib.md5(raw_uuid.encode()).hexdigest()
    
    # 3. 组合格式: "{uuid}{timestamp}infoc"
    buvid3 = f"{raw_uuid}{int(time.time())}infoc"
    return buvid3
```

**注意事项：**
- buvid3 应在同一会话中保持不变
- 频繁更换 buvid3 会触发风控
- 建议持久化存储 buvid3

---

## 3. 直播弹幕 WebSocket 协议

### 3.1 连接建立流程

```
┌─────────────┐     ①获取房间信息      ┌──────────────────┐
│   客户端     │ ──────────────────────> │  HTTP API        │
│             │ <────────────────────── │  (getDanmuInfo)  │
│             │     返回 token + hosts   │                  │
│             │                          └──────────────────┘
│             │     ②建立 WebSocket 连接
│             │ ──────────────────────> wss://host:443/sub
│             │                          ┌──────────────────┐
│             │     ③发送认证包(op=7)    │  WebSocket       │
│             │ ──────────────────────> │  Server          │
│             │ <────────────────────── │                  │
│             │     ④认证响应(op=8)      │                  │
│             │                          │                  │
│             │     ⑤每30秒心跳(op=2)    │                  │
│             │ <──────────────────────> │                  │
│             │     ⑥接收消息(op=5)      │                  │
└─────────────┘                          └──────────────────┘
```

### 3.2 获取连接信息

**Step 1: 获取真实房间号（短号→长号）**
```
GET https://api.live.bilibili.com/room/v1/Room/room_init?id={短房间号}

响应:
{
  "code": 0,
  "data": {
    "room_id": 545068,      // 真实房间号
    "short_id": 7777,       // 短房间号
    "uid": 8739477,         // 主播 UID
    "live_status": 1        // 1=直播中, 0=未直播
  }
}
```

**Step 2: 获取 WebSocket 连接信息和 Token**
```
GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id={真实房间号}&type=0

响应:
{
  "code": 0,
  "data": {
    "token": "t_E3lrIA1UuNvoz-NbFUN-h2P8Gw75hyBqpd_7bwSKKcM...",
    "host_list": [
      {
        "host": "tx-sh-live-comet-08.chat.bilibili.com",
        "port": 2243,
        "wss_port": 443,
        "ws_port": 2244
      },
      {
        "host": "broadcastlv.chat.bilibili.com",
        "port": 2243,
        "wss_port": 443,
        "ws_port": 2244
      }
    ]
  }
}
```

### 3.3 二进制消息协议

**包头格式（固定 16 字节，大端序）：**
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Packet Length (4B)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|        Header Length (2B)      |    Protocol Version (2B)      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Operation (4B)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Sequence ID (4B)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| 字段 | 大小 | 说明 |
|------|------|------|
| Packet Length | 4 bytes (int32) | 整个包长度（Header + Body） |
| Header Length | 2 bytes (int16) | 固定为 16 |
| Protocol Version | 2 bytes (int16) | 见下表 |
| Operation | 4 bytes (int32) | 操作码，见下表 |
| Sequence ID | 4 bytes (int32) | 客户端发包为 1 |

**协议版本（Protocol Version）：**

| 值 | 名称 | Body 格式 | 说明 |
|----|------|-----------|------|
| 0 | NORMAL | JSON 文本 | 无压缩，直接解析 |
| 1 | HEARTBEAT | int32 | 心跳包专用 |
| 2 | DEFLATE | Buffer | zlib 解压后递归解析 |
| 3 | BROTLI | Buffer | Brotli 解压后递归解析（**当前主流**） |

**操作码（Operation）：**

| 值 | 名称 | 发送方 | Body | 说明 |
|----|------|--------|------|------|
| 2 | HEARTBEAT | 客户端 | 空 | 每 30 秒发送一次 |
| 3 | HEARTBEAT_REPLY | 服务器 | int32 (人气值) | 心跳响应 |
| 5 | MESSAGE | 服务器 | JSON | 弹幕/礼物/SC 等所有业务消息 |
| 7 | AUTH | 客户端 | JSON | 认证包，连接后 5 秒内必须发送 |
| 8 | AUTH_REPLY | 服务器 | JSON `{code: 0}` | 认证成功响应 |

### 3.4 认证包（Auth Packet）

```json
{
  "uid": 0,                    // 用户 UID，0 表示游客
  "roomid": 545068,            // 真实房间号（非短号）
  "protover": 3,               // 协议版本，推荐 3（Brotli）
  "platform": "web",           // 平台
  "type": 2,                   // 固定值
  "key": "token_from_api"      // 从 getDanmuInfo 获取的 token
}
```

### 3.5 编码/解码实现

**TypeScript 编码示例：**
```typescript
function encode(packet: { op: number; data: any }): Buffer {
  const body = Buffer.from(JSON.stringify(packet.data), 'utf-8');
  const header = Buffer.alloc(16);
  header.writeInt32BE(16 + body.length, 0);  // Packet Length
  header.writeInt16BE(16, 4);                 // Header Length
  header.writeInt16BE(1, 6);                  // Protocol Version (HEARTBEAT)
  header.writeInt32BE(packet.op, 8);          // Operation
  header.writeInt32BE(1, 12);                 // Sequence ID
  return Buffer.concat([header, body]);
}
```

**Python 编码示例：**
```python
import struct
import json

HEADER_STRUCT = struct.Struct(">I2H2I")  # 大端序

def make_packet(data: dict, operation: int) -> bytes:
    body = json.dumps(data).encode("utf-8")
    header = HEADER_STRUCT.pack(
        16 + len(body),  # pack_len
        16,              # header_size
        1,               # ver (HEARTBEAT)
        operation,       # operation
        1                # seq_id
    )
    return header + body
```

**解码示例（处理 Brotli 压缩）：**
```typescript
async function decode(buffer: ArrayBuffer): Promise<any[]> {
  const view = new DataView(buffer);
  const packets: any[] = [];
  let offset = 0;

  while (offset < buffer.byteLength) {
    const packetLen = view.getInt32(offset);
    const headerLen = view.getInt16(offset + 4);
    const protoVer = view.getInt16(offset + 6);
    const op = view.getInt32(offset + 8);
    const body = buffer.slice(offset + headerLen, offset + packetLen);

    if (op === 5) { // MESSAGE
      if (protoVer === 3) {
        // Brotli 压缩，递归解码
        const decompressed = brotliDecompress(Buffer.from(body));
        packets.push(...await decode(decompressed));
      } else if (protoVer === 2) {
        // zlib 压缩
        const decompressed = zlib.inflateSync(Buffer.from(body));
        packets.push(...await decode(decompressed));
      } else {
        // 无压缩，直接解析 JSON
        const text = new TextDecoder().decode(body);
        packets.push(JSON.parse(text));
      }
    } else if (op === 3) {
      // 心跳回复，人气值
      packets.push({ op: 3, count: view.getInt32(offset + headerLen) });
    }

    offset += packetLen;
  }
  return packets;
}
```

---

## 4. WBI 签名机制

### 4.1 算法概述

自 2023 年 3 月起，B 站 Web 端部分接口开始采用 WBI 签名鉴权，表现为 REST API 请求时在 Query param 中添加了 `w_rid` 和 `wts` 字段。**WBI 签名鉴权独立于 APP 鉴权与其他 Cookie 鉴权，目前被认为是一种 Web 端风控手段。**

### 4.2 完整算法流程

```
┌──────────────────────────────────────────────────────────────┐
│ Step 1: 获取实时口令 img_key, sub_key                         │
│   GET https://api.bilibili.com/x/web-interface/nav           │
│   从 wbi_img.img_url 和 wbi_img.sub_url 中提取文件名          │
│   示例: "7cd084941338484aae1ad9425b84077c"                    │
│   ⚠️ 每日更替，建议 60 分钟刷新一次                            │
├──────────────────────────────────────────────────────────────┤
│ Step 2: 生成 mixin_key                                       │
│   raw_wbi_key = img_key + sub_key  (64 字符)                 │
│   遍历 MIXIN_KEY_ENC_TAB 重排取字符                           │
│   截取前 32 位 → mixin_key                                   │
├──────────────────────────────────────────────────────────────┤
│ Step 3: 计算签名 w_rid                                       │
│   1. 参数添加 wts (当前 Unix 秒时间戳)                        │
│   2. 按 key 升序排序                                         │
│   3. 过滤 value 中的 "!'()*" 字符                             │
│   4. URL 编码 (大写字母, 空格用 %20)                          │
│   5. 拼接 mixin_key                                          │
│   6. 计算 MD5 → w_rid                                        │
├──────────────────────────────────────────────────────────────┤
│ Step 4: 添加签名到请求                                        │
│   原始参数 + w_rid + wts → 最终请求                           │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 混淆表（MIXIN_KEY_ENC_TAB）

```javascript
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18,  2, 53,  8, 23, 32, 15, 50, 10, 31, 58,  3, 45, 35,
  27, 43,  5, 49, 33,  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48,  7, 16, 24, 55, 40, 61, 26, 17,  0,  1, 60, 51, 30,  4,
  22, 25, 54, 21, 56, 59,  6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
```

### 4.4 完整实现

**JavaScript 完整实现：**
```javascript
import md5 from 'md5';

// 1. 生成 mixin_key
const getMixinKey = (orig) =>
  MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);

// 2. WBI 签名
function encWbi(params, img_key, sub_key) {
  const mixin_key = getMixinKey(img_key + sub_key);
  const curr_time = Math.round(Date.now() / 1000);
  const chr_filter = /[!'()*]/g;

  // 添加 wts 字段
  Object.assign(params, { wts: curr_time });

  // 按 key 排序 + URL 编码
  const query = Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key].toString().replace(chr_filter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');

  // 计算 w_rid
  const wbi_sign = md5(query + mixin_key);
  return query + '&w_rid=' + wbi_sign;
}

// 3. 获取 img_key 和 sub_key
async function getWbiKeys(SESSDATA) {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      Cookie: `SESSDATA=${SESSDATA}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  const { data: { wbi_img: { img_url, sub_url } } } = await res.json();
  return {
    img_key: img_url.split('/').pop().split('.')[0],
    sub_key: sub_url.split('/').pop().split('.')[0],
  };
}
```

**Python 完整实现：**
```python
from functools import reduce
from hashlib import md5
import urllib.parse
import time
import requests

MIXIN_KEY_ENC_TAB = [
    46, 47, 18,  2, 53,  8, 23, 32, 15, 50, 10, 31, 58,  3, 45, 35,
    27, 43,  5, 49, 33,  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48,  7, 16, 24, 55, 40, 61, 26, 17,  0,  1, 60, 51, 30,  4,
    22, 25, 54, 21, 56, 59,  6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

def get_mixin_key(orig: str) -> str:
    return reduce(lambda s, i: s + orig[i], MIXIN_KEY_ENC_TAB, '')[:32]

def enc_wbi(params: dict, img_key: str, sub_key: str) -> dict:
    mixin_key = get_mixin_key(img_key + sub_key)
    curr_time = round(time.time())
    params['wts'] = curr_time
    params = dict(sorted(params.items()))
    params = {k: ''.join(c for c in str(v) if c not in "!'()*") for k, v in params.items()}
    query = urllib.parse.urlencode(params)
    wbi_sign = md5((query + mixin_key).encode()).hexdigest()
    params['w_rid'] = wbi_sign
    return params

def get_wbi_keys(cookies) -> tuple[str, str]:
    resp = requests.get(
        'https://api.bilibili.com/x/web-interface/nav',
        cookies=cookies,
        headers={'User-Agent': 'Mozilla/5.0 ...'}
    )
    data = resp.json()['data']['wbi_img']
    img_key = data['img_url'].rsplit('/', 1)[1].split('.')[0]
    sub_key = data['sub_url'].rsplit('/', 1)[1].split('.')[0]
    return img_key, sub_key
```

**TypeScript 完整实现（参考 danmakus-client）：**
```typescript
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// 混淆函数
function getMixinKey(origin: string): string {
  let mixed = '';
  for (const idx of WBI_MIXIN_KEY_ENC_TAB) {
    if (idx < origin.length) {
      mixed += origin[idx];
    }
  }
  return mixed.slice(0, 32);
}

// 签名函数
function buildWbiQueryString(
  params: Record<string, string>,
  imgKey: string,
  subKey: string
): string {
  const mixinKey = getMixinKey(imgKey + subKey);
  
  // 添加时间戳
  const withWts: Record<string, string> = {
    ...params,
    wts: String(Math.floor(Date.now() / 1000)),
  };

  // 按 key 字典序排序
  const sortedKeys = Object.keys(withWts).sort();
  const search = new URLSearchParams();
  for (const key of sortedKeys) {
    // 过滤 !'()* 字符
    const value = (withWts[key] ?? '').replace(/[!'()*]/g, '');
    search.set(key, value);
  }
  
  const query = search.toString();
  const wRid = md5Hex(query + mixinKey);  // MD5(查询串 + mixinKey)
  search.set('w_rid', wRid);
  return search.toString();
}

// 密钥获取（带缓存）
class WbiSigner {
  private wbiImgKey = '';
  private wbiSubKey = '';
  private wbiKeyExpireAt = 0;
  private readonly WBI_KEY_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1小时

  async getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
    const now = Date.now();
    if (this.wbiImgKey && this.wbiSubKey && now < this.wbiKeyExpireAt) {
      return { imgKey: this.wbiImgKey, subKey: this.wbiSubKey };
    }

    const response = await fetch('https://api.bilibili.com/x/web-interface/nav');
    const { data: { wbi_img: { img_url, sub_url } } } = await response.json();
    
    this.wbiImgKey = img_url.split('/').pop()?.split('.')[0] ?? '';
    this.wbiSubKey = sub_url.split('/').pop()?.split('.')[0] ?? '';
    this.wbiKeyExpireAt = now + this.WBI_KEY_REFRESH_INTERVAL_MS;
    
    return { imgKey: this.wbiImgKey, subKey: this.wbiSubKey };
  }
}
```

### 4.5 关键注意事项

| 问题 | 说明 |
|------|------|
| URL 编码大小写 | 编码字符字母应**大写**，部分库会错误编码为小写 |
| 空格编码 | 应编码为 `%20`，部分库会按 `application/x-www-form-urlencoded` 编码为 `+` |
| 特殊字符过滤 | 需过滤 value 中的 `!'()*` 字符 |
| 时间戳 | `wts` 为秒级 Unix 时间戳，不是毫秒 |
| 缓存策略 | `img_key` 和 `sub_key` 每日更替，建议 60 分钟检查一次更新 |
| **Referer 禁止** | **使用 WBI 签名的接口绝对不可以设置 header Referer** |

---

## 5. APP 签名机制

B站 APP 端接口使用不同的签名方式：

```python
def app_sign(params: dict, appkey: str, appsec: str) -> dict:
    """APP 端签名"""
    params.update({'appkey': appkey})
    params = dict(sorted(params.items()))
    query = urllib.parse.urlencode(params)
    sign = hashlib.md5((query + appsec).encode()).hexdigest()
    params.update({'sign': sign})
    return params
```

**常用 APP Key：**
| 平台 | appkey | appsec |
|------|--------|--------|
| Android | `1d8b6e7d45233436` | `560c52ccd288fed045859ed18bffd973` |
| iOS | `27eb53fc9058f8c3` | `c2ed53a74eeefe3cf99fbd01d8c9c375` |

---

## 6. 风控策略与规避

### 6.1 风控错误码

| 错误码 | 含义 | 触发条件 |
|--------|------|----------|
| `-352` | 风控校验失败 | 最常见的风控拦截，返回 `v_voucher` |
| `-401` | 非法访问 | WBI 签名错误或严重异常请求 |
| `-412` | 安全风控策略拒绝 | IP/频率/行为异常，HTTP 412 |
| `100003` | 验证码过期 | captcha 验证超时 |

### 6.2 风控检测维度

```
┌─────────────────────────────────────────────────────────────┐
│ 第一层：请求合法性验证                                        │
│   • User-Agent 缺失或异常（python-requests, curl 等）         │
│   • Referer 缺失或不匹配                                     │
│   • Cookie 不完整（缺少 buvid3, b_nut, bili_ticket 等）       │
│   • WBI 签名缺失或错误                                       │
├─────────────────────────────────────────────────────────────┤
│ 第二层：行为模式分析                                          │
│   • 请求频率过高（连续 5 秒内超过 8 次）                      │
│   • 固定间隔请求（无随机延迟）                                │
│   • 访问路径异常（直接调 API 无前置页面加载）                  │
│   • 单一 IP 高频请求                                          │
├─────────────────────────────────────────────────────────────┤
│ 第三层：高级风险识别                                          │
│   • 设备指纹（buvid3/buvid4 一致性）                         │
│   • HTTP/2 指纹识别                                          │
│   • 行为序列 AI 模型                                          │
│   • IP 地理分布异常                                           │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 风控响应格式

**-352 风控响应：**
```json
{
  "code": -352,
  "message": "风控校验失败",
  "ttl": 1,
  "data": {
    "v_voucher": "voucher_84a8c3ce-33f5-4551-9552-9c6b13aa7938"
  }
}
```

**-401 非法访问响应：**
```json
{
  "code": -401,
  "message": "非法访问",
  "data": {
    "ga_data": {
      "decisions": ["verify_captcha_level2"],
      "risk_level": 1,
      "grisk_id": "55aa98739b8235bf64ad75d38164dc40",
      "decision_ctx": {
        "origin_scene": "anti_crawler",
        "scene": "anti_crawler"
      }
    }
  }
}
```

### 6.4 风控规避最佳实践

| 策略 | 具体做法 |
|------|----------|
| **请求头伪装** | 使用真实浏览器 UA，包含完整的 Accept/Accept-Language 等头 |
| **Cookie 管理** | 确保包含 `SESSDATA`, `bili_jct`, `buvid3`, `buvid4`, `b_nut`, `bili_ticket` |
| **WBI 签名** | 所有 WBI 接口必须正确签名，缓存并定时刷新 key |
| **频率控制** | 单 IP 每分钟不超过 30 次请求，引入 0.5~3 秒随机延迟 |
| **指数退避** | 触发风控后等待时间翻倍重试 |
| **多域名轮换** | 3 个 API 域名：`api.bilibili.com`, `api.biliapi.com`, `api.biliapi.net` |
| **buvid 一致性** | 同一会话保持 buvid3/buvid4 不变 |
| **避免 Referer** | WBI 接口**不要**设置 Referer header |

### 6.5 推荐请求头模板

```javascript
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cookie': 'SESSDATA=xxx; bili_jct=xxx; buvid3=xxx; buvid4=xxx; b_nut=xxx; bili_ticket=xxx'
};
```

### 6.6 重试策略实现

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      
      // 检查是否为风控错误
      if (error.code === -352 || error.code === -412) {
        const delay = baseDelay * Math.pow(2, attempt);  // 指数退避
        const jitter = Math.random() * 1000;  // 随机抖动
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
        continue;
      }
      
      throw error;  // 非风控错误直接抛出
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## 7. 消息类型与数据结构

### 7.1 核心消息类型（CMD）

| CMD | 说明 | 关键字段 |
|-----|------|----------|
| `DANMU_MSG` | 弹幕消息 | `info[1]`（内容）, `info[2][0]`（UID）, `info[2][1]`（用户名）, `info[3]`（勋章）, `info[7]`（大航海等级） |
| `SEND_GIFT` | 赠送礼物 | `data.uname`, `data.giftName`, `data.num`, `data.coin_type` |
| `COMBO_SEND` | 礼物连击 | `data.uname`, `data.gift_name`, `data.combo_num` |
| `SUPER_CHAT_MESSAGE` | 醒目留言 (SC) | `data.message`, `data.price`, `data.user_info.uname` |
| `SUPER_CHAT_MESSAGE_JPN` | SC 日文版 | 同上 |
| `GUARD_BUY` | 开通舰长 | `data.username`, `data.gift_name`, `data.guard_level` |
| `USER_TOAST_MSG` | 上舰抽奖消息 | `data.toast_msg`, `data.uid` |
| `INTERACT_WORD` | 互动消息 | `data.uname`, `data.msg_type` |
| `ENTRY_EFFECT` | 舰长进入特效 | `data.face`, `data.copy_writing` |
| `WELCOME` | 欢迎进入 | `data.uname` |
| `WELCOME_GUARD` | 欢迎舰长 | `data.username` |
| `ROOM_REAL_TIME_MESSAGE_UPDATE` | 在线人数更新 | `data.fans`, `data.red_notice` |
| `LIVE` | 直播开始 | - |
| `PREPARING` | 直播准备中（结束） | - |

### 7.2 DANMU_MSG 弹幕消息详细结构

`DANMU_MSG` 是最核心的消息类型，其 `info` 数组包含发送者的完整身份信息（勋章、大航海等级等）。

#### info 数组顶层结构

| 索引 | 类型 | 内容 | 备注 |
|------|------|------|------|
| `info[0]` | array | 弹幕元信息 | 模式、颜色、时间戳、补充信息等 |
| `info[1]` | str | **弹幕文本内容** | |
| `info[2]` | array | **发送者基本信息** | uid、用户名等 |
| `info[3]` | array | **粉丝勋章信息** | 若未佩戴则为空数组 `[]` |
| `info[4]` | array | 用户 UL 等级信息 | |
| `info[5]` | array | 用户头衔信息 | |
| `info[7]` | num | **大航海等级** | 0=无, 1=总督, 2=提督, 3=舰长 |
| `info[9]` | obj | 发送时间戳 | |
| `info[16]` | array | 财富等级 | `info[16][0]` 为财富等级数值 |

#### info[2] 发送者基本信息

| 索引 | 类型 | 内容 | 备注 |
|------|------|------|------|
| `info[2][0]` | num | **发送者 UID** | |
| `info[2][1]` | str | **发送者用户名** | |
| `info[2][2]` | num | 是否为管理员 | 0=否, 1=是 |
| `info[2][3]` | num | 是否为 VIP | |
| `info[2][4]` | num | 是否为 SVIP | |
| `info[2][5]` | num | 用户权限等级 | |

#### info[3] 粉丝勋章数组（核心）

> 若用户未佩戴勋章，`info[3]` 为空数组 `[]`，需做判空处理。

| 索引 | 类型 | 内容 | 备注 |
|------|------|------|------|
| `info[3][0]` | num | **勋章等级** | |
| `info[3][1]` | str | **勋章名称** | |
| `info[3][2]` | str | **勋章所属主播名** | |
| `info[3][3]` | num | **勋章所属房间号** | |
| `info[3][4]` | num | 勋章颜色 | 十进制颜色值 |
| `info[3][5]` | str | 特殊勋章标识 | |
| `info[3][6]` | num | 0? | |
| `info[3][7]` | num | 勋章边框颜色 | |
| `info[3][8]` | num | 勋章渐变起始色 | |
| `info[3][9]` | num | 勋章渐变结束色 | |
| `info[3][10]` | num | **勋章关联房间的大航海等级** | 0=无, 1=总督, 2=提督, 3=舰长 |
| `info[3][11]` | num | **勋章是否点亮** | 1=点亮, 0=熄灭 |
| `info[3][12]` | num | **勋章所属主播 UID** | |

#### info[4] 用户 UL 等级数组

| 索引 | 类型 | 内容 | 备注 |
|------|------|------|------|
| `info[4][0]` | num | **用户 UL 等级** | |
| `info[4][2]` | num | UL 等级颜色 | |
| `info[4][3]` | str | UL 等级排名 | `>50000` 时为字符串 `">50000"` |

#### info[0][15] 补充信息对象

`info[0][15]` 是一个结构化对象，包含更丰富的用户和弹幕信息：

```jsonc
{
  "extra": "{...}",           // JSON 字符串，包含弹幕详情
  "mode": 1,                  // 弹幕模式
  "show_player_type": 0,
  "user": {                   // 用户详细信息
    "uid": 123456,
    "base": {
      "name": "用户名",
      "face": "头像URL",
      "name_color": 0,
      "is_mystery": false,
      "offical_info": { ... },  // 认证信息
      "origin_info": { ... }
    },
    "medal": {                // 粉丝勋章详情
      "level": 21,
      "name": "勋章名",
      "color": 2951253,
      "color_border": 16771156,
      "color_start": 2951253,
      "color_end": 10329087,
      "guard_level": 3,       // 大航海等级
      "is_light": 1,
      "ruid": 354656928       // 勋章主播 UID
    },
    "guard": null,
    "guard_leader": { ... },
    "title": { ... },
    "wealth": null,
    "uhead_frame": null
  }
}
```

#### 解析代码示例

```typescript
function parseDanmuMsg(info: any[]) {
  const msg = info[1];                    // 弹幕内容
  const uid = info[2][0];                 // 发送者 UID
  const uname = info[2][1];              // 发送者用户名
  const isAdmin = info[2][2] === 1;      // 是否管理员
  const privilegeType = info[7];          // 当前直播间大航海等级
  const wealthLevel = info[16]?.[0] ?? 0; // 财富等级

  // 粉丝勋章信息（需判空）
  let medal = null;
  if (info[3] && info[3].length > 0) {
    medal = {
      level: info[3][0],                  // 勋章等级
      name: info[3][1],                   // 勋章名称
      anchorName: info[3][2],             // 勋章所属主播名
      roomId: info[3][3],                 // 勋章所属房间号
      color: info[3][4],                  // 勋章颜色
      guardLevel: info[3][10],            // 勋章关联房间大航海等级
      isLight: info[3][11] === 1,         // 是否点亮
      anchorUid: info[3][12],             // 勋章所属主播 UID
    };
  }

  // UL 等级
  const ulLevel = info[4]?.[0] ?? 0;

  // 大航海等级文本
  const guardNames: Record<number, string> = {
    0: '', 1: '总督', 2: '提督', 3: '舰长'
  };
  const guardName = guardNames[privilegeType] ?? '';

  return { msg, uid, uname, isAdmin, medal, ulLevel, privilegeType, guardName, wealthLevel };
}
```

```python
# Python 解析示例（参考 astrbot_plugin_bilibili_live）
def parse_danmu_msg(info: list) -> dict:
    msg = info[1]
    uid = info[2][0]
    uname = info[2][1]
    is_admin = info[2][2] == 1
    privilege_type = info[7]  # 当前直播间大航海等级

    # 粉丝勋章（需判空）
    if len(info[3]) != 0:
        medal = {
            "level": info[3][0],
            "name": info[3][1],
            "anchor_name": info[3][2],
            "room_id": info[3][3],
            "color": info[3][4],
            "guard_level": info[3][10],  # 勋章关联房间大航海等级
            "is_light": info[3][11] == 1,
            "anchor_uid": info[3][12],
        }
    else:
        medal = None

    return {
        "msg": msg, "uid": uid, "uname": uname,
        "is_admin": is_admin, "medal": medal,
        "privilege_type": privilege_type,
    }
```

#### 关键注意事项

| 问题 | 说明 |
|------|------|
| `info[3]` 判空 | 用户未佩戴勋章时为空数组，直接访问会越界 |
| `guard_level` 有两个来源 | `info[7]` 是**当前直播间**的大航海等级，`info[3][10]` 是**勋章关联房间**的大航海等级，两者可能不同 |
| `info[0][15].user` 也有勋章 | 与 `info[3]` 数据相同，但结构化程度更高，解析路径更深 |
| 游客发送弹幕 | UID 可能为 0，勋章数组为空 |

### 7.3 SEND_GIFT 数据结构

```json
{
  "cmd": "SEND_GIFT",
  "data": {
    "action": "投喂",
    "uname": "用户名",
    "giftName": "小电视飞船",
    "giftId": 1,
    "num": 1,
    "price": 1245000,          // 价格（金瓜子），/1000 = 电池
    "coin_type": "gold",       // gold=付费, silver=免费
    "guard_level": 0,          // 0=普通, 1=总督, 2=提督, 3=舰长
    "uid": 123456,
    "timestamp": 1706835129
  }
}
```

### 7.4 SUPER_CHAT_MESSAGE 数据结构

```json
{
  "cmd": "SUPER_CHAT_MESSAGE",
  "data": {
    "uid": 123456,
    "message": "SC 内容",
    "message_jpn": "日文翻译",
    "price": 30,               // 人民币
    "time": 60,                // 持续秒数
    "start_time": 1706835129,
    "end_time": 1706835189,
    "user_info": {
      "uname": "用户名",
      "face": "头像URL",
      "guard_level": 3
    },
    "medal_info": {
      "medal_name": "粉丝牌名",
      "medal_level": 21,
      "target_id": 789
    },
    "gift": {
      "gift_id": 12000,
      "gift_name": "醒目留言"
    }
  }
}
```

### 7.5 GUARD_BUY 数据结构

```json
{
  "cmd": "GUARD_BUY",
  "data": {
    "username": "用户名",
    "uid": 123456,
    "gift_name": "舰长",       // 舰长/提督/总督
    "guard_level": 3,          // 1=总督, 2=提督, 3=舰长
    "num": 1,
    "price": 198000,           // 价格（金瓜子）
    "start_time": 1706835129,
    "end_time": 1706835189
  }
}
```

### 7.6 消息处理示例

```typescript
function handleMessage(data: any) {
  switch (data.cmd) {
    case 'DANMU_MSG':
      console.log(`[弹幕] ${data.info[2][1]}: ${data.info[1]}`);
      break;
    case 'SEND_GIFT':
      console.log(`[礼物] ${data.data.uname} ${data.data.action} ${data.data.giftName} x${data.data.num}`);
      break;
    case 'SUPER_CHAT_MESSAGE':
      console.log(`[SC ¥${data.data.price}] ${data.data.user_info.uname}: ${data.data.message}`);
      break;
    case 'GUARD_BUY':
      const levels = { 1: '总督', 2: '提督', 3: '舰长' };
      console.log(`[上舰] ${data.data.username} 开通${levels[data.data.guard_level]}`);
      break;
    case 'INTERACT_WORD':
      console.log(`[互动] ${data.data.uname} ${data.data.msg_type}`);
      break;
  }
}
```

---

## 8. 多房间并发架构

### 8.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    录制后台架构                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Room Worker │    │ Room Worker │    │ Room Worker │     │
│  │  (Room A)   │    │  (Room B)   │    │  (Room C)   │     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘     │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            │                                │
│                    ┌───────▼───────┐                        │
│                    │ Message Queue │                        │
│                    │  (去重/排序)   │                        │
│                    └───────┬───────┘                        │
│                            │                                │
│         ┌──────────────────┼──────────────────┐             │
│         │                  │                  │             │
│  ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐     │
│  │   Storage   │    │   Storage   │    │   Storage   │     │
│  │  (SQLite)   │    │  (PostgreSQL)│   │  (ClickHouse)│    │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Auth Manager                       │   │
│  │  • Cookie 管理 (多账号轮换)                          │   │
│  │  • WBI 签名器 (密钥缓存)                             │   │
│  │  • 风控检测 (自动降速)                               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Room Worker 设计

```typescript
class RoomWorker {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  constructor(
    private roomId: number,
    private authManager: AuthManager,
    private messageQueue: MessageQueue
  ) {}

  async start(): Promise<void> {
    // 1. 获取真实房间号
    const realRoomId = await this.getRealRoomId(this.roomId);
    
    // 2. 获取连接信息
    const { token, hostList } = await this.getDanmuInfo(realRoomId);
    
    // 3. 建立 WebSocket 连接
    const host = hostList[this.reconnectAttempts % hostList.length];
    this.ws = new WebSocket(`wss://${host.host}:${host.wss_port}/sub`);
    
    // 4. 设置事件处理
    this.ws.onopen = () => this.onConnect(realRoomId, token);
    this.ws.onmessage = (event) => this.onMessage(event);
    this.ws.onclose = () => this.onClose();
    this.ws.onerror = (error) => this.onError(error);
  }

  private onConnect(roomId: number, token: string): void {
    // 发送认证包
    const authPacket = this.encode({
      op: 7,
      data: {
        uid: 0,  // 游客模式
        roomid: roomId,
        protover: 3,
        platform: 'web',
        type: 2,
        key: token
      }
    });
    this.ws!.send(authPacket);

    // 启动心跳
    this.heartbeatTimer = setInterval(() => {
      this.ws!.send(this.encode({ op: 2, data: {} }));
    }, 30000);

    this.reconnectAttempts = 0;
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const messages = await this.decode(event.data);
    for (const msg of messages) {
      if (msg.op === 5) {  // 业务消息
        this.messageQueue.enqueue({
          roomId: this.roomId,
          cmd: msg.data.cmd,
          data: msg.data,
          timestamp: Date.now()
        });
      }
    }
  }

  private onClose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`Room ${this.roomId}: Max reconnect attempts reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;
    
    setTimeout(() => {
      this.reconnectAttempts++;
      this.start();
    }, delay + jitter);
  }
}
```

### 8.3 消息队列设计

```typescript
interface DanmakuMessage {
  roomId: number;
  cmd: string;
  data: any;
  timestamp: number;
}

class MessageQueue {
  private queue: DanmakuMessage[] = [];
  private readonly MAX_SIZE = 10000;
  private readonly DEDUP_WINDOW_MS = 2000;  // 2秒去重窗口
  private recentMessages = new Map<string, number>();

  enqueue(message: DanmakuMessage): void {
    // 去重检查
    const key = `${message.roomId}:${message.cmd}:${JSON.stringify(message.data)}`;
    const lastSeen = this.recentMessages.get(key);
    if (lastSeen && Date.now() - lastSeen < this.DEDUP_WINDOW_MS) {
      return;  // 重复消息，丢弃
    }
    this.recentMessages.set(key, Date.now());

    // 入队
    if (this.queue.length >= this.MAX_SIZE) {
      this.queue.shift();  // 溢出丢弃最早消息
    }
    this.queue.push(message);

    // 清理过期的去重记录
    if (this.recentMessages.size > 10000) {
      const now = Date.now();
      for (const [key, time] of this.recentMessages) {
        if (now - time > this.DEDUP_WINDOW_MS * 2) {
          this.recentMessages.delete(key);
        }
      }
    }
  }

  dequeue(): DanmakuMessage | undefined {
    return this.queue.shift();
  }
}
```

### 8.4 连接容量管理

```typescript
class ConnectionManager {
  private workers = new Map<number, RoomWorker>();
  private readonly MAX_CONNECTIONS: number;
  private connectQueue: number[] = [];
  private readonly CONNECT_INTERVAL_MS = 10000;  // 10秒间隔

  constructor(maxConnections: number = 50) {
    this.MAX_CONNECTIONS = maxConnections;
  }

  async addRoom(roomId: number): Promise<void> {
    if (this.workers.size >= this.MAX_CONNECTIONS) {
      this.connectQueue.push(roomId);
      return;
    }

    const worker = new RoomWorker(roomId, this.authManager, this.messageQueue);
    this.workers.set(roomId, worker);
    
    // 延迟启动，避免同时连接过多
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5000));
    await worker.start();
  }

  removeRoom(roomId: number): void {
    const worker = this.workers.get(roomId);
    if (worker) {
      worker.stop();
      this.workers.delete(roomId);
    }

    // 处理等待队列
    if (this.connectQueue.length > 0) {
      const nextRoomId = this.connectQueue.shift()!;
      this.addRoom(nextRoomId);
    }
  }
}
```

---

## 9. 关键 API 端点参考

### 9.1 认证相关

| 功能 | 方法 | 端点 |
|------|------|------|
| 申请二维码 | GET | `https://passport.bilibili.com/x/passport-login/web/qrcode/generate` |
| 轮询二维码 | GET | `https://passport.bilibili.com/x/passport-login/web/qrcode/poll` |
| Cookie 刷新检查 | GET | `https://passport.bilibili.com/x/passport-login/web/cookie/info` |
| Cookie 刷新 | POST | `https://passport.bilibili.com/x/passport-login/web/cookie/refresh` |
| 确认刷新 | POST | `https://passport.bilibili.com/x/passport-login/web/confirm/refresh` |
| 用户信息 (nav) | GET | `https://api.bilibili.com/x/web-interface/nav` |

### 9.2 直播间相关

| 功能 | 方法 | 端点 |
|------|------|------|
| 房间初始化 | GET | `https://api.live.bilibili.com/room/v1/Room/room_init?id={房间号}` |
| 弹幕信息 | GET | `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id={房间号}` |
| 直播间信息 | GET | `https://api.live.bilibili.com/xlive/web-room/v2/roomPlayInfo` |
| 礼物列表 | GET | `https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/roomGiftList` |
| 大航海列表 | GET | `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topListNew` |
| 历史弹幕 | GET | `https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory` |
| 发送弹幕 | POST | `https://api.live.bilibili.com/msg/send` |

### 9.3 用户相关

| 功能 | 方法 | 端点 |
|------|------|------|
| 用户信息 | GET | `https://api.bilibili.com/x/web-interface/card?mid={UID}` |
| 关注列表 | GET | `https://api.bilibili.com/x/relation/followings?vmid={UID}` |
| 粉丝列表 | GET | `https://api.bilibili.com/x/relation/followers?vmid={UID}` |

### 9.4 buvid 相关

| 功能 | 方法 | 端点 |
|------|------|------|
| 获取 buvid | GET | `https://api.bilibili.com/x/frontend/finger/spi` |

---

## 10. 参考实现与资源

### 10.1 本机参考项目路径

> 以下路径均为本机 `D:\AHEU\code\aicut\reference\` 目录下的参考项目，开发时可直接查阅源码。

#### 🔑 WBI 签名与认证（优先参考）

| 项目路径 | 关键文件 | 参考价值 |
|----------|----------|----------|
| `reference\danmakus-client-main\danmakus-core\src\core\BilibiliLiveWsAuthApi.ts` | WBI 签名完整实现 | ⭐⭐⭐⭐⭐ TypeScript 版 WBI 签名，含纯手写 MD5、密钥缓存、buvid 预热 |
| `reference\astrbot_plugin_bilibili_live-master\blivedm\clients\web.py` | WBI 签名 + Cookie 认证 | ⭐⭐⭐⭐⭐ Python 版 WBI 签名，含 WbiSigner 类、Cookie 解析 |
| `reference\danmakus-client-main\danmakus-core\src\core\AuthManager.ts` | 多 Cookie 源管理 | ⭐⭐⭐⭐ CookieCloud 同步、Cookie 验证、优先级策略 |

#### 📡 WebSocket 连接与消息处理

| 项目路径 | 关键文件 | 参考价值 |
|----------|----------|----------|
| `reference\danmakus-client-main\danmakus-core\src\core\WireRawLiveWsConnection.ts` | WebSocket 帧协议解析 | ⭐⭐⭐⭐⭐ Brotli/Deflate 解压、递归分包、DecompressionStream 降级 |
| `reference\astrbot_plugin_bilibili_live-master\blivedm\clients\ws_base.py` | WebSocket 基类 | ⭐⭐⭐⭐⭐ 16 字节包头编解码、心跳机制、重连逻辑、消息分包 |
| `reference\astrbot_plugin_bilibili_live-master\blivedm\clients\web.py` | Web 端弹幕客户端 | ⭐⭐⭐⭐ 认证包发送、房间信息获取、消息标准化 |
| `reference\astrbot_plugin_bilibili_live-master\blivedm\clients\open_live.py` | 开放平台客户端 | ⭐⭐⭐⭐ HMAC-SHA256 签名、游戏心跳、code=7003 处理 |
| `reference\astrbot_plugin_bilibili_live-master\blivedm\models\message.py` | 消息标准化模型 | ⭐⭐⭐⭐ web 和 open_live 统一转换为 BiliMessage |

#### 📦 消息队列与并发管理

| 项目路径 | 关键文件 | 参考价值 |
|----------|----------|----------|
| `reference\danmakus-client-main\danmakus-core\src\core\DanmakuMessageQueue.ts` | 消息队列实现 | ⭐⭐⭐⭐⭐ 消息去重（2秒窗口）、本地 outbox 落盘、指数退避重试、批量上传 |
| `reference\danmakus-client-main\danmakus-core\src\core\DanmakuHoldingRoomCoordinator.ts` | 房间持有协调器 | ⭐⭐⭐⭐ 连接队列调度、容量限制、Runtime 服务器房间分配 |
| `reference\danmakus-client-main\danmakus-core\src\core\DanmakuClient.ts` | 主控制器 | ⭐⭐⭐⭐ 1500+ 行，多房间连接管理、分布式锁、整体架构参考 |
| `reference\danmakus-client-main\danmakus-core\src\core\StreamerStatusManager.ts` | 主播状态轮询 | ⭐⭐⭐ 直播状态检测 |

#### 🔧 API 文档与 SDK

| 项目路径 | 关键文件 | 参考价值 |
|----------|----------|----------|
| `reference\bilibili-API-collect-main\docs\live\message_stream.md` | 直播消息流文档 | ⭐⭐⭐⭐⭐ WebSocket 协议、消息类型、操作码定义 |
| `reference\bilibili-API-collect-main\docs\misc\sign\wbi.md` | WBI 签名文档 | ⭐⭐⭐⭐⭐ WBI 算法官方文档 |
| `reference\bilibili-API-collect-main\docs\login\login_action\QR.md` | 扫码登录文档 | ⭐⭐⭐⭐ 登录流程、Cookie 获取 |
| `reference\bilibili-API-collect-main\docs\live\guard.md` | 大航海文档 | ⭐⭐⭐ 舰长/提督/总督相关 API |
| `reference\bilibili-API-collect-main\docs\misc\sign\APP.md` | APP 签名文档 | ⭐⭐⭐ APP 端签名算法 |
| `reference\bilibili-api-main\bilibili_api\live.py` | Python 直播 API | ⭐⭐⭐⭐ 1579 行，完整的直播 API 封装 |
| `reference\bilibili-api-main\bilibili_api\utils\network.py` | 网络工具 | ⭐⭐⭐⭐ 1769 行，HTTP 客户端、WBI 签名、重试机制 |
| `reference\bilibili-api-main\bilibili_api\login_v2.py` | 登录模块 | ⭐⭐⭐ 扫码登录、Cookie 刷新 |

#### 🎬 其他参考项目

| 项目路径 | 参考价值 |
|----------|----------|
| `reference\bililive-go-master\` | Go 语言多平台录制，平台插件化架构参考 |
| `reference\biliup-master\` | Rust+Python 混合架构，APP 签名、边录边传 |
| `reference\biliLive-tools-master\` | Electron 桌面应用，弹幕元数据嵌入视频 |
| `reference\bilive-main\` | Python 全链路自动化，弹幕→ASS 转换、自动切片 |

### 10.2 关键文件快速索引

开发弹幕录制后台时，按需查阅以下文件：

```
# WBI 签名（必须实现）
reference\danmakus-client-main\danmakus-core\src\core\BilibiliLiveWsAuthApi.ts
reference\astrbot_plugin_bilibili_live-master\blivedm\clients\web.py

# WebSocket 协议（必须实现）
reference\danmakus-client-main\danmakus-core\src\core\WireRawLiveWsConnection.ts
reference\astrbot_plugin_bilibili_live-master\blivedm\clients\ws_base.py

# 认证管理
reference\danmakus-client-main\danmakus-core\src\core\AuthManager.ts
reference\astrbot_plugin_bilibili_live-master\blivedm\clients\web.py

# 开放平台签名（可选）
reference\astrbot_plugin_bilibili_live-master\blivedm\clients\open_live.py

# 消息队列与并发
reference\danmakus-client-main\danmakus-core\src\core\DanmakuMessageQueue.ts
reference\danmakus-client-main\danmakus-core\src\core\DanmakuHoldingRoomCoordinator.ts
reference\danmakus-client-main\danmakus-core\src\core\DanmakuClient.ts

# API 文档
reference\bilibili-API-collect-main\docs\live\message_stream.md
reference\bilibili-API-collect-main\docs\misc\sign\wbi.md
reference\bilibili-API-collect-main\docs\login\login_action\QR.md
```

### 10.3 在线文档资源

| 资源 | URL |
|------|-----|
| bilibili-API-collect (最全) | https://github.com/SocialSisterYi/bilibili-API-collect |
| WBI 签名文档 | https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html |
| 直播 WebSocket 协议 | https://github.com/SocialSisterYi/bilibili-API-collect/docs/live/message_stream.md |
| 风控 v_voucher 文档 | https://github.com/pskdje/bilibili-API-collect/blob/main/docs/misc/sign/v_voucher.md |

### 10.4 技术栈建议

| 组件 | 推荐方案 |
|------|----------|
| 语言 | TypeScript (Node.js) 或 Python |
| WebSocket | ws (Node.js) 或 aiohttp (Python) |
| 数据库 | SQLite (单机) / PostgreSQL (分布式) / ClickHouse (分析) |
| 消息队列 | Redis Stream 或 RabbitMQ |
| 压缩 | brotli (WASM) 或 zlib |
| HTTP 客户端 | undici (Node.js) 或 httpx (Python) |

---

## 附录 A: 常见问题

### Q1: 为什么 WebSocket 连接后收不到消息？
A: 检查是否在 5 秒内发送了认证包 (op=7)，以及 roomid 是否为真实房间号（非短号）。

### Q2: 为什么 API 请求返回 -352？
A: 这是风控拦截，检查 WBI 签名是否正确、Cookie 是否完整、请求频率是否过高。

### Q3: 为什么 WBI 签名验证失败？
A: 常见原因：URL 编码大小写错误、空格编码为 `+` 而非 `%20`、未过滤 `!'()*` 字符、设置了 Referer header。

### Q4: 如何处理 buvid3？
A: buvid3 应在首次访问时生成并持久化存储，同一会话中保持不变。可通过 `https://api.bilibili.com/x/frontend/finger/spi` 获取。

### Q5: 多账号如何轮换？
A: 建议维护账号池，按请求次数或时间间隔轮换，触发风控时切换到下一个账号。

---

## 附录 B: 更新日志

| 日期 | 更新内容 |
|------|----------|
| 2026-05-03 | 初始版本，基于 danmakus-client、astrbot_plugin_bilibili_live、bilibili-API-collect、bilibili-api 整理 |
| 2026-05-03 | 补充本机参考项目路径，便于开发时直接查阅源码 |
| 2026-05-03 | 补充 DANMU_MSG info 数组详细结构（勋章、大航海等级、UL 等级等） |
