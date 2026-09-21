'use strict';

/**
 * 生成应用图标（build/icon.ico + 多尺寸 PNG），零依赖。
 *
 * 为什么要自己写 PNG/ICO 编码而不是装 sharp / png-to-ico：
 * 图标只在打包时用一次，为它引入一个带原生扩展的依赖不划算 —— 那种依赖
 * 还会在不同 Node/Electron 版本下需要重建。
 *
 * 图标设计沿用界面自身的配色（styles.css 里的 CSS 变量）：
 *   底色 #14161a（--bg）、圆角方块
 *   主体 #6aa9ff（--accent）
 * 图形语义：左侧「视频帧」序列 → 右侧「文本行」，对应 harness 干的事
 * （把视频反推成结构化提示词）。用色块而非文字，小尺寸下也能辨认。
 *
 * 用法：node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');

// 界面配色（与 src/renderer/styles.css 保持一致）
const BG = [0x14, 0x16, 0x1a];
const ACCENT = [0x6a, 0xa9, 0xff];
const ACCENT_DIM = [0x3d, 0x66, 0x99];
const OK = [0x4e, 0xc9, 0xa0];

// --------------------------------------------------------------------------- //
// 绘制
// --------------------------------------------------------------------------- //

/**
 * 在一个 size×size 的画布上绘制图标，返回 RGBA 像素数组。
 *
 * 全程用「归一化坐标 + 超采样」的方式：先按 4 倍尺寸画，再降采样。
 * 直接画目标尺寸会让圆角与线条出现明显锯齿。
 */
function render(size) {
  const SS = 4; // 超采样倍数
  const N = size * SS;
  const buf = new Uint8ClampedArray(N * N * 4);

  const set = (x, y, rgb, alpha) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    const a = alpha === undefined ? 1 : alpha;
    if (a >= 1) {
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
    } else {
      // 简单 alpha 合成（叠加在已有像素上）
      const dstA = buf[i + 3] / 255;
      const outA = a + dstA * (1 - a);
      if (outA <= 0) return;
      for (let c = 0; c < 3; c += 1) {
        buf[i + c] = Math.round((rgb[c] * a + buf[i + c] * dstA * (1 - a)) / outA);
      }
      buf[i + 3] = Math.round(outA * 255);
    }
  };

  /** 圆角矩形填充，带抗锯齿（按到边界距离做 1px 渐变）。 */
  const roundRect = (x0, y0, x1, y1, r, rgb, alpha = 1) => {
    for (let y = Math.floor(y0 - 1); y <= Math.ceil(y1 + 1); y += 1) {
      for (let x = Math.floor(x0 - 1); x <= Math.ceil(x1 + 1); x += 1) {
        // 到圆角矩形的有符号距离
        const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
        const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
        const dist = Math.hypot(dx, dy) - r;
        const inX = x >= x0 - 1 && x <= x1 + 1;
        const inY = y >= y0 - 1 && y <= y1 + 1;
        if (!inX || !inY) continue;
        if (dist <= -1) set(x, y, rgb, alpha);
        else if (dist < 0) set(x, y, rgb, alpha * (1 + dist));
      }
    }
  };

  const u = N / 100; // 100 单位归一化坐标

  // 底板：深色圆角方块，占满画布
  roundRect(u * 2, u * 2, N - u * 2, N - u * 2, u * 22, BG);

  // ── 左侧：三格「视频帧」序列（自上而下淡出，暗示视频的时间维度）──
  const frameX = u * 20;
  const frameW = u * 26;
  const frameH = u * 15;
  const rows = [
    { y: u * 27, color: ACCENT, alpha: 1 },
    { y: u * 45.5, color: ACCENT, alpha: 0.72 },
    { y: u * 64, color: ACCENT, alpha: 0.46 },
  ];
  for (const row of rows) {
    roundRect(frameX, row.y, frameX + frameW, row.y + frameH, u * 3.5, row.color, row.alpha);
  }

  // ── 中间：箭头（反推的方向：视频 → 提示词）──
  const arrowY = u * 50;
  const arrowX0 = u * 50;
  const arrowX1 = u * 62;
  const shaft = u * 3.2;
  roundRect(arrowX0, arrowY - shaft / 2, arrowX1 - u * 3, arrowY + shaft / 2, shaft / 2, ACCENT_DIM);
  // 箭头三角
  for (let x = 0; x <= u * 6; x += 1) {
    const t = 1 - x / (u * 6);
    const half = (u * 7) * t;
    for (let y = -half; y <= half; y += 1) {
      set(Math.round(arrowX1 - u * 6 + x), Math.round(arrowY + y), ACCENT_DIM);
    }
  }

  // ── 右侧：三条「文本行」（长短不一，暗示结构化提示词）──
  const textX = u * 66;
  const lineH = u * 4.6;
  const lines = [
    { y: u * 33, w: u * 15, color: OK },
    { y: u * 47.7, w: u * 15, color: OK },
    { y: u * 62.4, w: u * 9.5, color: OK },
  ];
  for (const line of lines) {
    roundRect(textX, line.y, textX + line.w, line.y + lineH, lineH / 2, line.color);
  }

  // ── 降采样：SS×SS 盒式平均 ──
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }

  return out;
}

// --------------------------------------------------------------------------- //
// PNG 编码（最小实现：8 位 RGBA，无交错）
// --------------------------------------------------------------------------- //

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());

  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每行前置 filter 字节 0（None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------------- //
// ICO 封装（PNG 压缩型，Vista+ 支持；Windows 10/11 无兼容问题）
// --------------------------------------------------------------------------- //

function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;

  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry[0] = img.size >= 256 ? 0 : img.size;  // 256 用 0 表示
    entry[1] = img.size >= 256 ? 0 : img.size;
    entry[2] = 0;  // palette
    entry[3] = 0;  // reserved
    entry.writeUInt16LE(1, 4);    // color planes
    entry.writeUInt16LE(32, 6);   // bits per pixel
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// --------------------------------------------------------------------------- //

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 256 是 electron-builder 的硬性要求（它自己会缩放出其它尺寸）
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = [];
  const pngs = [];

  for (const size of sizes) {
    const rgba = render(size);
    const png = encodePng(size, Buffer.from(rgba));
    images.push({ size, data: png });
    pngs.push({ size, png });
    console.log(`  已绘制 ${size}×${size}`);
  }

  const ico = encodeIco(images);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`\nicon.ico：${icoPath}（${(ico.length / 1024).toFixed(1)} KB，含 ${sizes.length} 种尺寸）`);

  // 同时留一份 512 的 PNG，供 Linux/macOS 或文档使用
  const png512 = encodePng(512, Buffer.from(render(512)));
  const pngPath = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(pngPath, png512);
  console.log(`icon.png：${pngPath}（512×512，${(png512.length / 1024).toFixed(1)} KB）`);

  // 校验 ICO 头，避免生成了坏文件还不知道
  const head = fs.readFileSync(icoPath).subarray(0, 6);
  const isIco = head.readUInt16LE(0) === 0 && head.readUInt16LE(2) === 1;
  console.log(`\nICO 头校验：${isIco ? 'PASS' : 'FAIL'}（条目数 ${head.readUInt16LE(4)}）`);
  process.exit(isIco ? 0 : 1);
}

main();
