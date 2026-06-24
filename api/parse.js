// Vercel Serverless Function
// 部署方式: 整个 douyin-parser 目录推到 GitHub，Vercel 导入即可

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url: input } = req.body;
    if (!input) return res.status(400).json({ error: '请提供抖音分享链接' });

    const shareUrl = input.trim();
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

    // Step 1: follow redirect
    const r1 = await fetch(shareUrl, { headers: { 'User-Agent': ua }, redirect: 'manual' });
    const location = r1.headers.get('Location') || '';
    if (!location) return res.status(400).json({ error: '无法获取重定向地址' });

    const fullUrl = location.startsWith('http') ? location : 'https://www.iesdouyin.com' + location;

    // Step 2: fetch page
    const pageRes = await fetch(fullUrl, { headers: { 'User-Agent': ua } });
    const html = await pageRes.text();

    // Step 3: extract RENDER_DATA
    const rdMatch = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>(.*?)<\/script>/s);
    if (!rdMatch) return res.status(400).json({ error: '解析失败：未找到页面数据' });

    let raw = rdMatch[1];
    raw = decodeURIComponent(raw);
    const data = JSON.parse(raw);

    const app = data?.app || data;
    const itemList = app?.item_list || data?.item_list || [];
    const item = Array.isArray(itemList) ? itemList[0] : itemList;
    if (!item) return res.status(400).json({ error: '解析失败：未找到作品数据' });

    const result = {
      aweme_id: item.aweme_id,
      desc: item.desc,
      aweme_type: item.aweme_type,
      duration: item.video?.duration || item.duration || 0,
      statistics: item.statistics || {},
      author: item.author ? { nickname: item.author.nickname, unique_id: item.author.unique_id, uid: item.author.uid } : null,
      music: null,
      video: null,
      images: [],
    };

    if (item.music) {
      result.music = {
        title: item.music.title || '',
        play_url: buildUrls(item.music.play_url?.uri, item.music.play_url?.url_list),
      };
    }

    if (item.aweme_type === 0 && item.video?.play_addr) {
      result.video = {
        play: buildUrls(item.video.play_addr.uri, item.video.play_addr.url_list),
        download: item.video.download_addr ? buildUrls(item.video.download_addr.uri, item.video.download_addr.url_list) : null,
        cover: item.video.cover ? buildUrls(item.video.cover.uri, item.video.cover.url_list) : null,
        width: item.video.width,
        height: item.video.height,
      };
    }

    if (item.aweme_type === 2 && Array.isArray(item.images)) {
      result.images = item.images.map(img => ({
        width: img.width,
        height: img.height,
        no_watermark: buildUrls(img.uri, img.url_list),
        with_watermark: buildUrls(img.uri, img.download_url_list),
      }));
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || '解析异常' });
  }
}

function buildUrls(uri, urlList) {
  if (!urlList || !Array.isArray(urlList)) return [];
  return urlList.map(u => u.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16))).replace(/\\/g, ''));
}
