#!/usr/bin/env node
/* ============================================================================
 * play2xiaomi · build.js —— 构建脚本（零依赖，一个 node 没别的）
 *
 * 做三件事：
 *   1. 把 src/core.js + src/main.js【纯拼接】成 dist/p2x.js：
 *      不压缩、不转译、保留全部可读性，只是"减少 .js 文件数量"。
 *   2. node --check 校验产物语法（web/package.json 声明 type=module）。
 *   3. 用 --url 生成 dist/index.html（拖拽安装 bookmarklet 的指南页）。
 *
 * 用法：
 *   node build.js                        # 用默认占位 URL
 *   node build.js --url https://me.github.io/play2xiaomi/p2x.js
 * ========================================================================== */
"use strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = (name) => readFileSync(join(ROOT, "src", name), "utf8");
const section = (title, code) =>
  `/* ============================================================= ${title} */\n${code.trim()}\n`;

/* ---------------------------------------------------------------- 1. 拼接 */

const banner = `/* ============================================================================
 * play2xiaomi（书签小程序版）· dist/p2x.js
 *
 * 由 build.js 从 src/core.js + src/main.js 纯拼接生成——想改逻辑请改 src，
 * 然后重新 node build.js。不要手改本文件。
 *
 * 书签安装形式：    javascript:import('<托管地址>/p2x.js?t=' + Date.now())
 * '?t=' 是 cache-busting：动态 import 有模块缓存，重复点击书签必须换 URL
 * 才能重新执行；页内以 #p2x-root 是否存在来防重复注入（见 main.js）。
 *
 * 运行环境约定：页面必须与被调用 API 同源（api2.mina.mi.com /
 * account.xiaomi.com），无 CORS 障碍、无服务器、凭证存于浏览器原生 Cookie。
 * ========================================================================== */
`;
const dist =
  banner +
  section("part 1 / 2 · core.js（协议层：登录、换票、Mina 客户端、QR 生成）", SRC("core.js")) + "\n" +
  section("part 2 / 2 · main.js（界面层：入口分派、面板 UI、登录编排）", SRC("main.js"));

mkdirSync(join(ROOT, "dist"), { recursive: true });
const distPath = join(ROOT, "dist", "p2x.js");
writeFileSync(distPath, dist);
console.log(`[1/3] dist/p2x.js 写入完成（${dist.length} 字节，未压缩）`);

/* ------------------------------------------------------------ 2. 语法自检 */

const check = spawnSync("node", ["--check", distPath], { encoding: "utf8" });
if (check.status !== 0) {
  console.error("[2/3] node --check 失败：\n" + (check.stderr || check.stdout));
  process.exit(1);
}
console.log("[2/3] node --check 通过（dist/p2x.js 语法有效）");

/* ---------------------------------------------------------- 3. 指南页产物 */

let url = "https://REPLACE-ME.github.io/play2xiaomi/p2x.js";
const args = process.argv.slice(2);
const at = args.indexOf("--url");
if (at !== -1 && args[at + 1]) url = args[at + 1].replace(/\/$/, "");

// 书签形态：javascript:import('<URL>?t=' + Date.now())
// （动态 import 自带模块缓存，带上时间戳才能书签反复点击反复执行）
const bookmarklet = `javascript:import('${url}?t=' + Date.now())`;
const html = readFileSync(join(ROOT, "index.src.html"), "utf8")
  .split("__P2X_URL__").join(url)
  .split("__P2X_JS__").join(bookmarklet);
writeFileSync(join(ROOT, "dist", "index.html"), html);
console.log("[3/3] dist/index.html 写入完成（托管地址已注入：" + url + "）");
