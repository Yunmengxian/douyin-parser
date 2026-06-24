# 已知坑与解法

## CF Workers 环境

### Response.redirect() 不可用
**现象:** `Response.redirect(url, 302)` → 500 / 1101 (Worker exception)
**解法:** 手动构造 302:
```js
return new Response(null, {
  status: 302,
  headers: { 'Location': '/?url=' + encodeURIComponent(target) }
});
```

### 模板字符串吃掉正则转义
**现象:** 前端 JS 写在 Worker 的模板字符串 `\`...\`` 里，正则 `\s` `\/` `\.` 全部失效
**原因:** 模板字面量处理 `\\` → `\`，`\s` → `s`（`\s` 不是有效的模板转义）
**解法:** 双反斜杠：`\\s` `\\/` `\\.`
```js
// ✅ 在模板字符串内
var m = v.match(/https?:\\/\\/[^\\s]*?(?:douyin\\.com|iesdouyin\\.com)\\/[^\\s]+/i);
// 浏览器看到的实际正则: /https?:\/\/[^\s]*?(?:douyin\.com|iesdouyin\.com)\/[^\s]+/i
```

### 302 自循环 (1101)
**现象:** 302 → 302 → ... → 1101 (Worker exceeded limits)
**原因:** 用 `request.url`（含 query string 完整 URL）匹配 douyin 链接，目标页 `/?url=...` 的 query string 又被匹配到
**解法:** **只匹配 `url.pathname`**，不碰 query string:
```js
const path = url.pathname;
if (path.length > 3 && path.indexOf('douyin.com/') > 1) {
  // redirect
}
```

### Workers.dev 域名被墙
**现象:** `douyin-parser.xxx.workers.dev` 国内无法访问
**解法:** 绑定自定义域名，在 Cloudflare Dashboard → Workers → Triggers → Custom Domains

## 抖音反爬

### 页面 RENDER_DATA / SSR_DATA 无数据
**现象:** `RENDER_DATA` 只有少量元数据，`_SSR_DATA` 只有空 data 壳
**解法:** 数据在 `window._ROUTER_DATA` 里：
```js
const rd = html.match(/window\._ROUTER_DATA\s*=\s*({.+?})\s*<\/script>/s);
const data = JSON.parse(rd[1]);
const items = data.loaderData["note_(id)/page"].videoInfoRes.item_list;
```

### 内部 API 需要加密签名
**现象:** 直接调 `aweme/detail/` 返回 `encrypt_data_miss`
**解法:** 走页面 HTML 解析（`_ROUTER_DATA`），不调内部 API

### CF Worker IP 被拦截
**现象:** 部分 douyin 页面请求返回验证页面
**解法:** 使用与海外访问点兼容的 UA 和 Referer：
```js
headers: {
  'User-Agent': 'Mozilla/5.0 ...',
  'Referer': 'https://www.douyin.com/',
}
```
页面 Set-Cookie `is_oversea=1` 时可正常返回含作品数据的页面。

## URL 处理

### 路径直链输入框残留
**现象:** 粘贴完整 share text 后输入框有多余中文
**解法:** `doParse()` 中用正则自动提取纯 URL，`inp.value = m[0]` 替换：
```js
var m = v.match(/https?:\/\/[^\s]+?(?:douyin\.com|iesdouyin\.com)\/[^\s]+/i);
if (m) v = m[0];
inp.value = v;
```

### 视频 /playwm/ 有水印
**现象:** `play_addr` 只返回 `/playwm/` 地址（有水印）
**解法:** 替换为 `/play/` 得无水印：
```js
video.no_watermark = play_addr.map(u => u.replace(/\/playwm\//, '/play/'));
```

### 视频直链点击无法播放
**现象:** 超链接点击跳转无法播放，复制粘贴可播放
**原因:** 抖音 CDN 检查 Referer 头
**解法:** 通过 Worker `/video?src=xxx` 代理视频流，Worker 端加 Referer 头

## 按钮/事件

### 复制按钮 onclick 失效
**现象:** 模板字符串拼接 `onclick="copy('${url}')"` 后按钮无反应
**解法:** 用 `data-url` 属性 + 事件委托：
```html
<button class="copy-btn" data-url="...">复制</button>
```
```js
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.copy-btn');
  if (!btn) return;
  var url = btn.getAttribute('data-url');
  navigator.clipboard.writeText(url).then(...);
});
```

### 回车解析无效
**现象:** 输入框回车无反应
**解法:** `keydown` 事件加 `e.preventDefault()`，按钮加 `type="button"`，form 加 `onsubmit="return false"`
