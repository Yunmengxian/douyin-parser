export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' }
      });
    }
    // Proxy video stream to avoid CORS/redirect issues
    if (url.pathname === '/video' && url.searchParams.has('src')) {
      return streamVideo(url.searchParams.get('src'), request.headers.get('Range'));
    }

    // Path redirect
    const path = url.pathname;
    if (path.length > 3 && (path.indexOf('douyin.com/') > 1 || path.indexOf('iesdouyin.com/') > 1)) {
      const di = path.indexOf('/') === 0 ? 1 : 0;
      const rest = path.slice(di);
      const target = rest.startsWith('https://') || rest.startsWith('http://') ? rest : 'https://' + rest;
      const clean = target.split('?')[0].split('#')[0];
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/?url=' + encodeURIComponent(clean) }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/parse') {
      return handleParse(request);
    }
    return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};

async function streamVideo(encodedUrl, rangeHeader) {
  const src = decodeURIComponent(encodedUrl);
  const headers = {
    'User-Agent': UA_MOBILE,
    'Referer': 'https://www.douyin.com/',
  };
  if (rangeHeader) headers['Range'] = rangeHeader;

  const resp = await fetch(src, { headers, redirect: 'follow' });
  const outHeaders = new Headers({
    'Content-Type': resp.headers.get('Content-Type') || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
  });
  if (resp.headers.has('Content-Length')) outHeaders.set('Content-Length', resp.headers.get('Content-Length'));
  if (resp.headers.has('Content-Range')) outHeaders.set('Content-Range', resp.headers.get('Content-Range'));

  return new Response(resp.body, {
    status: resp.status,
    headers: outHeaders,
  });
}

async function handleParse(request) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
  try {
    // Verify request comes from our own frontend
    const ref = (request.headers.get('Referer') || '').toLowerCase();
    const host = (new URL(request.url)).hostname;
    if (!ref.includes(host) && !ref.includes('localhost')) {
      return json({ error: '请通过页面访问' }, 403, cors);
    }
    const { url: input } = await request.json();
    if (!input) return json({ error: '请输入抖音分享链接' }, 400, cors);

    const shareUrl = input.trim();
    let targetUrl = shareUrl;
    const urlMatch = shareUrl.match(/https?:\/\/v\.douyin\.com\/[^\s]+/i)
      || shareUrl.match(/https?:\/\/www\.iesdouyin\.com\/share\/(?:video|note)\/(\d+)/i);
    if (urlMatch) targetUrl = urlMatch[0];

    // Follow short link redirect
    let fullUrl = targetUrl;
    if (targetUrl.includes('v.douyin.com')) {
      const r = await fetch(targetUrl, { headers: { 'User-Agent': UA_MOBILE }, redirect: 'manual' });
      const loc = r.headers.get('Location') || '';
      if (loc) fullUrl = loc.startsWith('http') ? loc : 'https://www.iesdouyin.com' + loc;
    }

    // Multi-strategy fetch with fallbacks for IP blocking
    let item = null;

    // Strategy 1: iesdouyin.com HTML page (primary, has _ROUTER_DATA SSR)
    try {
      const res = await fetch(fullUrl, {
        headers: { 'User-Agent': UA_MOBILE, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': 'https://www.douyin.com/' },
        redirect: 'follow'
      });
      const html = await res.text();
      if (!isBlockedPage(html)) item = extractItemFromHtml(html);
    } catch {}

    // Strategy 2: Detail API (separate rate limit group from page scraping)
    if (!item) {
      const awemeId = fullUrl.match(/\/(\d{15,20})\/?/)?.[1];
      if (awemeId) try {
        const apiRes = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}`, {
          headers: { 'User-Agent': UA_MOBILE, 'Referer': 'https://www.douyin.com/' }
        });
        const apiData = await apiRes.json();
        item = apiData?.aweme_detail || null;
      } catch {}
    }

    if (!item) {
      return json({ error: '解析失败：抖音反爬拦截，所有策略均失败' }, 400, cors);
    }

    return json(buildResult(item), 200, cors);

  } catch (e) {
    return json({ error: e.message || '解析异常' }, 500, cors);
  }
}

// Extract and parse a script-level JSON object like window.XXX = {...}
function parseScriptJSON(html, startIdx, transformer) {
  const eqIdx = html.indexOf('=', startIdx);
  const scriptEnd = html.indexOf('</script>', eqIdx);
  if (eqIdx < 0 || scriptEnd <= eqIdx) return null;

  let seg = html.substring(eqIdx + 1, scriptEnd).trim().replace(/;\s*$/, '');
  let braceStart = seg.indexOf('{');
  if (braceStart < 0) return null;

  let depth = 0, jsonEnd = -1;
  for (let i = braceStart; i < seg.length; i++) {
    if (seg[i] === '{') depth++;
    else if (seg[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }
  if (jsonEnd <= braceStart) return null;

  try {
    let raw = seg.substring(braceStart, jsonEnd);
    raw = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
    const data = JSON.parse(raw);
    return transformer(data);
  } catch {
    return null;
  }
}

// Detect captcha/block responses from Douyin
function isBlockedPage(html) {
  if (!html || html.length < 500) return true;
  // Real captcha pages are tiny, not full content pages with captcha SDK URLs
  if (html.length < 2000 && html.includes('滑块')) return true;
  return false;
}

// Extract item data from HTML (RENDER_DATA or _ROUTER_DATA)
function extractItemFromHtml(html) {
  // Strategy A: RENDER_DATA (China IP SSR)
  let m = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>(.*?)<\/script>/s)
       || html.match(/<script[^>]*id="SSR_HYDRATED_DATA"[^>]*>(.*?)<\/script>/s);
  if (m) {
    try {
      let raw = decodeURIComponent(m[1]);
      const data = JSON.parse(raw);
      const app = data?.app || data;
      const list = app?.['item_list'] || data?.['item_list'] || [];
      return Array.isArray(list) ? list[0] : list;
    } catch {}
  }
  // Strategy B: _ROUTER_DATA (non-China IP SSR)
  const rtrIdx = html.indexOf('window._ROUTER_DATA');
  if (rtrIdx >= 0) {
    return parseScriptJSON(html, rtrIdx, (rtrData) => {
      const loaderData = rtrData?.loaderData || {};
      for (const key of Object.keys(loaderData)) {
        const pageData = loaderData[key];
        if (pageData?.['videoInfoRes']?.item_list?.length) {
          return pageData.videoInfoRes.item_list[0];
        }
      }
      return null;
    });
  }
  return null;
}

function buildNoWatermarkUrls(videoId) {
  if (!videoId) return [];
  // Construct watermark-free URLs with different quality levels
  const base = 'https://aweme.snssdk.com/aweme/v1/play/';
  return [
    base + '?video_id=' + videoId + '&ratio=1080p&line=0',
    base + '?video_id=' + videoId + '&ratio=720p&line=0',
  ];
}

function buildResult(item) {
  const r = {
    aweme_id: item.aweme_id,
    desc: item.desc,
    aweme_type: item.aweme_type,
    statistics: item.statistics || {},
    author: item.author ? {
      nickname: item.author.nickname,
      unique_id: item.author.unique_id,
      uid: item.author.uid
    } : null,
    music: null, video: null, images: [],
  };

  if (item.music) {
    r.music = {
      title: item.music.title || '',
      play_url: clean(item.music.play_url?.url_list),
      cover: clean(item.music.cover_hd?.url_list || item.music.cover_medium?.url_list),
    };
  }

  // Video (type 0 = normal, type 4 = live photo / short video)
  if ((item.aweme_type === 0 || item.aweme_type === 4) && item.video?.play_addr) {
    const vid = item.video.play_addr.uri;
    r.video = {
      play: clean(item.video.play_addr.url_list),
      // Watermark-free: clean URL without logo_name & watermark params
      no_watermark: buildNoWatermarkUrls(vid),
      download: clean(item.video.download_addr?.url_list),
      cover: clean(item.video.cover?.url_list),
      width: item.video.width || item.video.origin_cover?.width,
      height: item.video.height || item.video.origin_cover?.height,
      duration: item.video.duration,
    };
  }

  if (item.aweme_type === 2 && Array.isArray(item.images)) {
    r.images = item.images.map(img => ({
      width: img.width,
      height: img.height,
      no_watermark: clean(img.url_list),
      with_watermark: clean(img.download_url_list),
    }));
  }

  return r;
}

function clean(list) {
  return (list || []).map(u =>
    u.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16))).replace(/\\/g, '')
  );
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>抖音解析</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%23fe2c55'/%3E%3Cstop offset='100%25' style='stop-color:%2325f4ee'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect rx='14' width='64' height='64' fill='url(%23g)'/%3E%3Cpath d='M26 18v20c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6c.6 0 1.2.1 1.8.3V22l14-4v12h-.1z' fill='%23fff'/%3E%3C/svg%3E" type="image/svg+xml">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{width:100%;max-width:640px;padding:24px}
h1{text-align:center;font-size:24px;margin-bottom:8px;background:linear-gradient(135deg,#fe2c55,#25f4ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{text-align:center;color:#888;font-size:13px;margin-bottom:24px}
.input-group{display:flex;gap:10px;margin-bottom:20px}
input{flex:1;padding:12px 16px;border-radius:12px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:15px;outline:none;transition:border .2s}
input:focus{border-color:#fe2c55}
input::placeholder{color:#555}
.btn{padding:12px 24px;border-radius:12px;border:none;background:#fe2c55;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}.btn:disabled{opacity:.4;cursor:not-allowed}
.loading{text-align:center;color:#888;margin:16px 0;display:none}
.error{background:#2a1010;border:1px solid #fe2c55;border-radius:12px;padding:16px;color:#fe2c55;margin-top:16px;display:none;white-space:pre-wrap}
.result{display:none;margin-top:16px}
.card{background:#1a1a1a;border-radius:16px;padding:20px;margin-bottom:16px;border:1px solid #2a2a2a}
.card h3{font-size:14px;color:#888;margin-bottom:12px;letter-spacing:1px}
.meta{color:#aaa;font-size:13px;margin-bottom:12px;line-height:1.6}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.stat{font-size:12px;color:#666}.stat b{color:#ccc}
.url-list{max-height:300px;overflow-y:auto}
.url-item{background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:12px;word-break:break-all;position:relative}
.url-item .label{font-size:10px;color:#666;margin-bottom:4px}
.url-item a{color:#25f4ee;text-decoration:none;overflow-wrap:anywhere}
.url-item a:hover{text-decoration:underline}
.copy-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:#333;border:none;color:#aaa;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer}
.copy-btn:hover{background:#444;color:#fff}
video{width:100%;border-radius:12px;background:#000;max-height:400px}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600}
.tag-video{background:#1a2a2a;color:#25f4ee}.tag-image{background:#2a1a2a;color:#d44}
.footer{text-align:center;color:#444;font-size:11px;margin-top:32px}
</style>
</head>
<body>
<div class="container">
<h1>抖音解析</h1>
<p class="sub">粘贴抖音分享链接，提取无水印图片/视频</p>
<form class="input-group" onsubmit="return false">
<input type="text" id="input" placeholder="https://v.douyin.com/xxxxx/ 或口令" autofocus>
<button type="button" class="btn" id="btn">解析</button>
</form>
<div class="loading" id="loading">解析中...</div>
<div class="error" id="error"></div>
<div class="result" id="result"></div>
<p class="footer">仅供学习使用</p>
</div>
<script>
(function(){
var inp=document.getElementById('input');
var btn=document.getElementById('btn');
var loading=document.getElementById('loading');
var error=document.getElementById('error');
var result=document.getElementById('result');

function doParse(){
var v=inp.value.trim();
if(!v)return;
// Auto-extract Douyin URL from share text (backslashes doubled for template literal survival: \\s → \s, \\. → \., \\/ → \/)
var m=v.match(/https?:\\/\\/[^\\s]*?(?:douyin\\.com|iesdouyin\\.com)\\/[^\\s]+/i);
if(m)v=m[0];
inp.value=v;
btn.disabled=true;
loading.style.display='block';
error.style.display='none';
result.style.display='none';
fetch('/api/parse',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({url:v})
}).then(function(r){return r.json()}).then(function(d){
loading.style.display='none';
btn.disabled=false;
if(d.error){error.textContent=d.error;error.style.display='block';return}
result.innerHTML=render(d);
result.style.display='block';
// Auto-play video & audio after DOM update
setTimeout(function(){
var v=result.querySelector('video');if(v)v.play().catch(function(){});
var a=result.querySelector('audio');if(a)a.play().catch(function(){});
},100);
}).catch(function(e){
loading.style.display='none';
btn.disabled=false;
error.textContent='网络错误: '+e.message;
error.style.display='block';
});
}

function render(d){
var tag=d.aweme_type===2?'<span class="tag tag-image">图集</span>':'<span class="tag tag-video">视频</span>';
var h='<div class="card"><h3>作品信息</h3><div class="meta">';
h+='<div style="font-size:15px;color:#fff;margin-bottom:4px">'+esc(d.desc)+'</div>';
if(d.author)h+='<div>作者: '+esc(d.author.nickname)+' (@'+esc(d.author.unique_id)+')</div>';
h+='<div>类型: '+tag+'</div><div class="stats">';
var s=d.statistics;
if(s.digg_count!=null)h+='<span class="stat">赞 <b>'+fmt(s.digg_count)+'</b></span>';
if(s.comment_count!=null)h+='<span class="stat">评论 <b>'+fmt(s.comment_count)+'</b></span>';
if(s.share_count!=null)h+='<span class="stat">分享 <b>'+fmt(s.share_count)+'</b></span>';
if(s.collect_count!=null)h+='<span class="stat">收藏 <b>'+fmt(s.collect_count)+'</b></span>';
h+='</div></div></div>';
if(d.video){h+='<div class="card"><h3>视频</h3>';var vu=d.video.no_watermark&&d.video.no_watermark.length?d.video.no_watermark[0]:d.video.play[0];if(d.video.duration)h+='<div style="color:#888;font-size:12px;margin-bottom:6px">时长: '+(d.video.duration/1000).toFixed(0)+'s</div>';h+='<video controls autoplay muted loop playsinline preload="auto" src="/video?src='+encodeURIComponent(vu)+'" style="margin-bottom:12px"></video>';h+='<div class="url-list">';if(d.video.no_watermark&&d.video.no_watermark.length)h+=urls('无水印',d.video.no_watermark);h+=urls('有水印',d.video.play);if(d.video.download&&d.video.download.length)h+=urls('下载',d.video.download);h+='</div></div>';}
if(d.music){h+='<div class="card"><h3>背景音乐</h3>';if(d.music.title)h+='<div style="color:#aaa;font-size:12px;margin-bottom:8px">'+esc(d.music.title)+'</div>';if(d.music.play_url&&d.music.play_url.length){h+='<audio controls autoplay preload="auto" src="'+d.music.play_url[0]+'" referrerpolicy="no-referrer" style="width:100%;margin-bottom:8px"></audio>';h+='<div class="url-list">'+urls('MP3直链',d.music.play_url)+'</div>';}h+='</div>';}
if(d.images.length){
h+='<div class="card"><h3>图片直链 ('+d.images.length+'张)</h3>';
d.images.forEach(function(img,i){
h+='<div style="margin-bottom:12px"><div style="color:#aaa;font-size:12px;margin-bottom:4px">图片 '+(i+1)+' ('+img.width+'x'+img.height+')</div>';
h+='<details style="margin-bottom:6px"><summary style="color:#25f4ee;cursor:pointer;font-size:12px">无水印</summary><div class="url-list" style="margin-top:6px">'+urls('',img.no_watermark)+'</div></details>';
h+='<details><summary style="color:#888;cursor:pointer;font-size:12px">有水印</summary><div class="url-list" style="margin-top:6px">'+urls('',img.with_watermark)+'</div></details></div>';
});
h+='</div>';
}
return h;
}

function urls(label,list){
return list.map(function(u){
var eu=u.replace(/'/g,"\\\\'");
return'<div class="url-item"><div class="label">'+(label||'直链')+'</div><a href="'+u+'" target="_blank" referrerpolicy="no-referrer">'+u+'</a><button class="copy-btn" data-url="'+esc(u)+'">复制</button></div>';
}).join('');
}

function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function fmt(n){return n>=10000?(n/10000).toFixed(1)+'w':n;}

// Copy button handler via delegation
document.addEventListener('click',function(e){
var btn=e.target.closest('.copy-btn');
if(!btn)return;
var url=btn.getAttribute('data-url');
navigator.clipboard.writeText(url).then(function(){
btn.textContent='已复制';
setTimeout(function(){btn.textContent='复制';},1500);
}).catch(function(){
btn.textContent='失败';
setTimeout(function(){btn.textContent='复制';},1500);
});
});

// Bind events
btn.addEventListener('click',doParse);
inp.addEventListener('keydown',function(e){
if(e.key==='Enter'){e.preventDefault();doParse();}
});

// Auto-parse from ?url= parameter (for path redirects)
(function(){
var m=location.search.match(/[?&]url=([^&]+)/);
if(m){inp.value=decodeURIComponent(m[1]);doParse();}
})();
})();
</script>
</body>
</html>`;
