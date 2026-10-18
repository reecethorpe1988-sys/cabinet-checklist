// photos.js — let Claude see a photo, and host local photos publicly (as JPEG)
// on Cloudinary so Instagram can fetch them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PHOTOS_DIR } from './state.js';

const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function localPhotoPath(filename) {
  const p = path.resolve(PHOTOS_DIR, filename);
  if (!p.startsWith(path.resolve(PHOTOS_DIR) + path.sep)) throw new Error('Photo must be inside the photos/ folder.');
  if (!fs.existsSync(p)) throw new Error(`No photo named ${filename} in photos/.`);
  return p;
}

// Content blocks for a tool result, so Claude actually sees the image.
export function photoBlocks(source) {
  if (/^https:\/\//.test(source)) {
    if (/example\.com\/mock-photos/.test(source)) {
      return [{ type: 'text', text: `${source} is a placeholder from the simulated store; there is no real photo to look at. Describe the product from its listing instead.` }];
    }
    return [{ type: 'image', source: { type: 'url', url: source } }, { type: 'text', text: `Photo: ${source}` }];
  }
  const p = localPhotoPath(source);
  const type = MEDIA_TYPES[path.extname(p).toLowerCase()];
  if (!type) return [{ type: 'text', text: `${source} is a format Claude can't view (e.g. HEIC). It can still be hosted and posted; host_photo converts it to JPEG.` }];
  const data = fs.readFileSync(p);
  if (data.length > 5 * 1024 * 1024) return [{ type: 'text', text: `${source} is over 5 MB, too big to view. Host it first and look at the hosted URL instead.` }];
  return [{ type: 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } }, { type: 'text', text: `Photo: ${source}` }];
}

function parseCloudinaryUrl(url) {
  const m = url?.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (!m) throw new Error('CLOUDINARY_URL is not set (format cloudinary://API_KEY:API_SECRET@CLOUD_NAME). Needed to post photos from photos/.');
  return { apiKey: m[1], apiSecret: m[2], cloud: m[3] };
}

// Upload to Cloudinary as JPEG, max 1440px wide; returns a public https URL.
export async function hostPhoto(filename, env = process.env) {
  const p = localPhotoPath(filename);
  if ((env.IG_MODE || 'mock') !== 'live' && !env.CLOUDINARY_URL) {
    return `https://example.com/mock-hosted/${encodeURIComponent(path.basename(p, path.extname(p)))}.jpg`;
  }
  const { apiKey, apiSecret, cloud } = parseCloudinaryUrl(env.CLOUDINARY_URL);
  const params = {
    folder: 'iris',
    format: 'jpg',
    public_id: path.basename(p, path.extname(p)).replace(/[^\w-]/g, '_'),
    timestamp: String(Math.floor(Date.now() / 1000)),
    transformation: 'c_limit,w_1440,q_auto:good',
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
  const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
  const body = new URLSearchParams({
    ...params, api_key: apiKey, signature,
    file: `data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}`,
  });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${json.error?.message || res.status}`);
  return json.secure_url;
}
