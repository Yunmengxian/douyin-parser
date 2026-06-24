---
name: douyin-parser
description: 维护和部署抖音链接解析服务。涉及 douyin-parser 项目（CF Workers/Vercel）的代码修改、功能添加、bug 修复、部署、调试。触发场景：抖音解析器出问题、需要加新功能、部署更新、worker.js 修改、douyin.960005.xyz 相关操作、wrangler deploy。
---

# 抖音解析器维护

## 概述

抖音分享链接解析为无水印图片/视频直链的 Web 服务。部署在 Cloudflare Workers（`douyin.960005.xyz`），Vercel 备用。

## 工作流程

### 修改代码

1. 项目在 `{workspace}/douyin-parser/worker.js`
2. 参考 `assets/worker.js` 了解当前线上版本
3. 修改后 `npx wrangler deploy` 部署到 CF Workers

### 关键守则

- **模板字符串内的正则**: 所有 `\s` `\/` `\.` 必须写成 `\\s` `\\/` `\\.`（模板字面量会吃掉一层反斜杠）
- **302 跳转**: 不用 `Response.redirect()`（CF Workers 运行时抛异常），用 `new Response(null, {status: 302, headers: {Location: ...}})`
- **302 匹配只用 pathname**: 不要用 `request.url` 匹配 douyin 链接，用 `url.pathname`，否则 `/` 页面自循环
- **前端事件**: 按钮用 `type="button"` + `addEventListener`，复制用 `data-url` 属性 + 事件委托，回车加 `e.preventDefault()`
- **视频无水印**: 原始 `play_addr` 是 `/playwm/`，替换为 `/play/` 得到无水印

### 部署到 CF Workers

```bash
cd {workspace}/douyin-parser
npx wrangler deploy
```

部署后验证:
- `https://douyin.960005.xyz/` 首页正常
- `POST /api/parse` 返回解析结果
- 路径直链 302 跳转正常

### 部署到 GitHub

```bash
cd {workspace}/douyin-parser
git add -A
git commit -m "..."
git push
```

仓库: `https://github.com/Yunmengxian/douyin-parser`

## 参考资料

- **已知坑**: `references/pitfalls.md` — 所有踩过的坑及解法，改代码前必读
- **项目架构**: `references/project.md` — 目录结构、Worker 内部结构、API 规格
- **当前代码**: `assets/worker.js` — 线上版本参考

## 抖音解析策略

数据源: 抖音分享页面 HTML 中的 `window._ROUTER_DATA` JSON
数据路径: `loaderData["note_(id)/page"].videoInfoRes.item_list[]`

请求头:
```
User-Agent: Mozilla/5.0 ...
Referer: https://www.douyin.com/
```

解析流程:
1. 请求短链接 `https://v.douyin.com/xxx/` → 跟踪重定向
2. 获取最终 HTML 页面
3. 正则提取 `window._ROUTER_DATA = {...}`
4. 遍历 item_list，提取:
   - type=2: 图集 (images + 背景音乐)
   - type=0/4: 视频 (video.play_addr → /play/ 无水印)
5. 返回重组后的 JSON

## 路径路由

| 路径 | 行为 |
|------|------|
| `GET /` | 首页 |
| `GET /?url=xxx` | 首页 + JS 自动解析 |
| `GET /https://v.douyin.com/xxx/` | 302 → `/?url=xxx` |
| `GET /video?src=...` | 视频代理流 (加 Referer) |
| `POST /api/parse` | 解析 API |
