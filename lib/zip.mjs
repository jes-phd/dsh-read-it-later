// 把一轮里生成的文件打成一个 zip，用「会话标题第 N 轮.zip」命名。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonBin } from './collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP_SCRIPT = path.join(HERE, '..', 'zip-files.py');
const HOME = process.env.USERPROFILE ?? os.homedir();
export const OUTBOX = path.join(HOME, '.dsh', 'read-it-later', 'outbox');

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 去掉文件名里 Windows 不允许的字符，并压掉多余空白。 */
export function safeName(input, fallback = '会话') {
  const cleaned = String(input ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 80);
}

export function zipNameFor(title, turn) {
  const base = safeName(title, '会话分享');
  return Number.isInteger(turn) ? `${base}第 ${turn} 轮.zip` : `${base}.zip`;
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 只保留本机确实存在、且是普通文件的路径。 */
export function existingFiles(list) {
  const out = [];
  for (const p of list ?? []) {
    try {
      if (typeof p !== 'string' || !p) continue;
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.push({ path: p, name: path.basename(p), bytes: st.size });
    } catch {}
  }
  return out;
}

/** 打包；失败时抛出带原因的 Error，调用方回退到逐个发送。 */
export function zipFiles(files, outPath, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
    const child = execFile(
      pythonBin(),
      [ZIP_SCRIPT],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`zip-failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
        }
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').pop());
          if (!j.ok) return reject(new Error(String(j.error || 'zip-failed')));
          resolve(j);
        } catch {
          reject(new Error('zip-failed: unparsable output'));
        }
      },
    );
    child.stdin.end(JSON.stringify({ out: outPath, files }));
  });
}
