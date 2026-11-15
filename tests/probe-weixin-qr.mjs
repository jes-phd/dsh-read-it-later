// 探针：看微信返回的 qrcode_img_content 到底是图片还是页面。
import * as weixin from '../lib/weixin.mjs';

const r = await weixin.beginLogin();
console.log('qrcode=', r.qrcode, '\nurl=', r.qrUrl);

const uas = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'node',
];

for (const ua of uas) {
  try {
    const res = await fetch(r.qrUrl, { headers: { 'user-agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`${ua.slice(0, 24)} -> ${res.status} ${res.headers.get('content-type')} bytes=${buf.length} first=${buf.subarray(0, 12).toString('hex')}`);
  } catch (e) {
    console.log(`${ua.slice(0, 24)} -> ERR ${e.message}`);
  }
}
