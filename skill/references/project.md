# 项目架构

## 技术栈

- **主要部署:** Cloudflare Workers (单文件 worker.js)
- **备用部署:** Vercel Serverless Functions
- **前端:** 单页 HTML (内嵌在 worker.js 模板字符串中)
- **解析策略:** 多策略降级 — 页面抓取 → API 直调

## 目录结构

```
douyin-parser/          ← 项目根 (git 仓库)
├── worker.js           ← CF Worker 主文件 (前端+API一体)
├── index.html          ← 独立前端页面 (备用, 用于 Vercel)
├── api/parse.js        ← Vercel Serverless Function (备用)
├── wrangler.toml       ← Cloudflare Wrangler 配置
├── vercel.json         ← Vercel 部署配置
├── package.json        ← 项目元信息
├── skill/              ← OpenClaw 维护 Skill
└── README.md           ← 项目说明
```

## worker.js 结构

```
┌─ export default { fetch() } ─┐
│  ├─ OPTIONS CORS 处理        │
│  ├─ /video 视频代理          │
│  ├─ 路径直链 → 302 跳转     │
│  ├─ POST /api/parse → 解析  │
│  └─ GET / → 返回 HTML 页面  │
├─ streamVideo()               │
├─ handleParse()               │
│  ├─ 多策略获取 (防IP拉黑)    │
│  │  ├─ S1: iesdouyin 页面   │
│  │  └─ S2: detail API 降级  │
│  ├─ Referer 校验 (403拦截)  │
│  └─ buildResult() 重组数据   │
├─ isBlockedPage()             │
├─ extractItemFromHtml()       │
│  ├─ RENDER_DATA / SSR_DATA   │
│  └─ _ROUTER_DATA 手动JSON   │
├─ parseScriptJSON()           │
├─ buildResult()               │
│  ├─ type=2 图集              │
│  ├─ type=0/4 视频            │
│  └─ 提取 image/music/video   │
└─ const HTML = `...`          │  ← 前端页面 (模板字符串)
   └─ <script>                 │
      ├─ doParse()             │
      ├─ render()              │
      └─ 事件绑定 + 自动解析   │
```

## 反爬多策略

CF Workers IP 被抖音页面级拉黑时，自动降级：

| 策略 | 入口 | 数据来源 | 限流分组 |
|------|------|----------|----------|
| S1 | `iesdouyin.com/share/` HTML | `_ROUTER_DATA` / `RENDER_DATA` | 页面抓取 |
| S2 | `douyin.com/aweme/v1/web/aweme/detail/` API | `aweme_detail` JSON | API 调用 |

S2 使用独立的限流分组，IP 被页面级拦截时仍可工作。

## 部署

### CF Workers (主)
```bash
npx wrangler deploy
```
域名: `douyin.960005.xyz` (自定义域绑定到 `douyin-parser.1730896963.workers.dev`)

### Vercel (备用)
```bash
vercel deploy --prod
```

### GitHub
```bash
git remote add origin https://github.com/Yunmengxian/douyin-parser.git
```

## 关键 API Endpoint

`POST /api/parse`
- 请求体: `{"url": "https://v.douyin.com/xxxxx/"}`
- Referer 校验: 必须来自本站域名或 localhost，否则返回 403
- 返回: `{aweme_id, desc, aweme_type, music, images[], video{}, statistics, author}`

`GET /video?src=<encoded_url>` 代理视频流 (加 Referer 头绕过防盗链)

## 路径策略

- `GET /` → 首页
- `GET /?url=xxx` → 首页 + 自动解析 (JS 读取 `?url=` 参数)
- `GET /https://v.douyin.com/xxx/` → 302 → `/?url=xxx`
- `POST /api/parse` → 解析 API
