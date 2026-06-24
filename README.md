# 抖音解析器 · Douyin Parser

粘贴抖音分享链接，提取无水印图片/视频直链。支持视频和图集。

## 🔵 部署到 Cloudflare Workers

```bash
npm install -g wrangler
wrangler login
cd douyin-parser
wrangler deploy
```

访问 `https://douyin-parser.你的账号.workers.dev`

## ⚪ 部署到 Vercel

1. 把 `douyin-parser` 目录推到 GitHub
2. Vercel 导入仓库 → Framework: Other
3. 部署，访问分配的域名

或 CLI：
```bash
npm i -g vercel
cd douyin-parser
vercel --prod
```

## 本地开发

```bash
wrangler dev    # CF Workers → localhost:8787
vercel dev      # Vercel → localhost:3000
```

## 文件说明

| 文件 | 用途 |
|------|------|
| `worker.js` | CF Worker（前端HTML + 解析API一体） |
| `wrangler.toml` | CF 配置 |
| `api/parse.js` | Vercel Serverless Function |
| `index.html` | 前端页面（Vercel静态 + 独立使用） |
| `vercel.json` | Vercel 路由配置 |
