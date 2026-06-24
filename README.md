# 抖音解析器 · Douyin Parser

> 粘贴抖音分享链接，提取无水印视频 / 图集直链。双平台部署，CF Workers 为主，Vercel 备用。

[![Deployed on Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare)](https://douyin.960005.xyz)
[![Vercel](https://img.shields.io/badge/Vercel-backup-black?logo=vercel)](https://vercel.com)

---

## 功能

- **视频解析** — 提取无水印播放地址、下载地址
- **图集解析** — 逐张提取无水印 / 有水印直链
- **音乐提取** — 提取背景音乐 MP3 直链
- **视频代理** — Worker 端代理视频流，绕过 Referer 防盗链
- **分享口令兼容** — 粘贴完整分享文案，自动提取 URL
- **多策略反反爬** — 页面抓取 → API 降级，IP 被屏蔽时自动切换

## 域名

| 环境 | 地址 |
|------|------|
| 生产 | [douyin.960005.xyz](https://douyin.960005.xyz) |
| Worker 源站 | `douyin-parser.1730896963.workers.dev` |

---

## 部署

### Cloudflare Workers（主）

```bash
npm install -g wrangler
wrangler login
cd douyin-parser
wrangler deploy
```

> ⚠️ `workers.dev` 域名国内无法访问，需在 Dashboard → Workers → Triggers → Custom Domains 绑定自己的域名。

### Vercel（备用）

```bash
npm i -g vercel
cd douyin-parser
vercel --prod
```

或导入 GitHub 仓库 → Framework: Other → 部署。

### 本地开发

```bash
wrangler dev     # → localhost:8787
```

---

## 架构

```
worker.js (单文件，前端 + API 一体)
├── GET  /             → 返回 HTML 页面
├── GET  /?url=xxx     → 页面 + 自动解析
├── GET  /<douyin-url> → 302 → /?url=<encoded>
├── POST /api/parse    → 解析 API（Referer 校验）
└── GET  /video?src=   → 视频流代理
```

### 解析策略

| 策略 | 入口 | 数据来源 | 触发条件 |
|------|------|----------|----------|
| S1 | 页面 HTML | `_ROUTER_DATA` / `RENDER_DATA` | 默认 |
| S2 | Detail API | `aweme_detail` JSON | S1 被 IP 拦截时降级 |

S2 使用独立限流分组，IP 被页面级屏蔽时仍可工作。

### 文件说明

| 文件 | 用途 |
|------|------|
| `worker.js` | CF Worker 主文件（HTML + API + 视频代理） |
| `wrangler.toml` | Wrangler 部署配置 |
| `index.html` | 独立前端页面（Vercel 使用） |
| `api/parse.js` | Vercel Serverless Function（简化版） |
| `vercel.json` | Vercel 路由配置 |
| `skill/` | OpenClaw 维护 Skill（项目架构 + 已知坑文档） |

---

## API

### POST /api/parse

**请求体：**

```json
{"url": "https://v.douyin.com/xxxxx/"}
```

**Referer 校验：** 必须来自本站域名或 `localhost`，否则返回 403。

**成功响应：**

```json
{
  "aweme_id": "7000000000000000000",
  "desc": "作品描述",
  "aweme_type": 0,
  "statistics": { "digg_count": 12345, "comment_count": 678 },
  "author": { "nickname": "作者", "unique_id": "author_id" },
  "video": {
    "play": ["https://..."],
    "no_watermark": ["https://..."],
    "download": ["https://..."],
    "cover": ["https://..."],
    "width": 1080, "height": 1920, "duration": 15000
  },
  "images": [
    { "width": 1080, "height": 1920, "no_watermark": ["..."], "with_watermark": ["..."] }
  ],
  "music": { "title": "BGM", "play_url": ["https://..."] }
}
```

- `aweme_type`: 0/4 = 视频，2 = 图集
- URL 数组包含多个 CDN 节点，取第一个即可
- `no_watermark` 仅在 Worker 版本可用

### GET /video?src=\<encoded_url\>

代理视频流，Worker 端加 Referer 头绕过防盗链。

---

## 已知坑

<details>
<summary><b>CF Workers 环境限制</b></summary>

- `Response.redirect()` 不可用 → 手动构造 302
- 模板字符串吃掉正则转义 → 双反斜杠 `\\s` `\\/`
- `workers.dev` 域名国内被墙 → 绑定自定义域名

</details>

<details>
<summary><b>抖音反爬</b></summary>

- `RENDER_DATA` 有时无数据 → 改用 `window._ROUTER_DATA`
- 内部 API 需加密签名 → 走页面 HTML 解析
- CF Worker IP 可能被拦截 → 双策略降级

</details>

<details>
<summary><b>视频播放</b></summary>

- `/playwm/` 地址有水印 → 替换为 `/play/`
- 直链点击无法播放 → 通过 Worker `/video` 代理加 Referer

</details>

完整踩坑记录见 [`skill/references/pitfalls.md`](skill/references/pitfalls.md)。

---

## 更新日志

| 日期 | 变更 |
|------|------|
| 2026-06-20 | 修复 IP 被拦截：S2 Detail API 降级策略 |
| 2026-06-17 | 路径重定向 302 自循环修复 |
| 2026-06-16 | 模板字符串转义修复、复制按钮事件委托 |
| 2026-06-15 | 初始版本：多策略解析、视频代理、图集支持 |

## License

MIT — 仅供学习使用。
