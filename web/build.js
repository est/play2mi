#!/usr/bin/env node
/* ============================================================================
 * play2mi · build.js —— 构建脚本（零依赖，一个 node 没别的）
 *
 * 做三件事：
 *   1. 把 src/core.js + src/main.js【纯拼接】成 dist/init.js：
 *      不压缩、不转译、保留全部可读性，只是"减少 .js 文件数量"。
 *   2. node --check 校验产物语法（web/package.json 声明 type=module）。
 *   3. 把自包含的 index.html 原样拷到 dist/index.html。
 *
 * 用法：
 *   node build.js
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
 * play2mi（书签小程序版）· dist/init.js
 *
 * 由 build.js 从 src/core.js + src/main.js 纯拼接生成——想改逻辑请改 src，
 * 然后重新 node build.js。不要手改本文件。
 *
 * 书签安装形式：    javascript:import('<托管地址>/init.js?t=' + Date.now())
 * '?t=' 是 cache-busting：动态 import 有模块缓存，重复点击书签必须换 URL
 * 才能重新执行；页内以 #p2m-root 是否存在来防重复注入（见 main.js）。
 *
 * 运行环境约定：页面必须与被调用 API 同源（api2.mina.mi.com /
 * account.xiaomi.com），无 CORS 障碍、无服务器、凭证存于浏览器原生 Cookie。
 * ========================================================================== */
`;
const dist =
  banner +
  section("part 1 / 2 · core.js（协议层：登录、换票、Mina 客户端）", SRC("core.js")) + "\n" +
  section("part 2 / 2 · main.js（界面层：入口分派、面板 UI、登录编排）", SRC("main.js"));

mkdirSync(join(ROOT, "dist"), { recursive: true });
const distPath = join(ROOT, "dist", "init.js");
writeFileSync(distPath, dist);
console.log(`[1/3] dist/init.js 写入完成（${dist.length} 字节，未压缩）`);

/* ------------------------------------------------------------ 2. 语法自检 */

const check = spawnSync("node", ["--check", distPath], { encoding: "utf8" });
if (check.status !== 0) {
  console.error("[2/3] node --check 失败：\n" + (check.stderr || check.stdout));
  process.exit(1);
}
console.log("[2/3] node --check 通过（dist/init.js 语法有效）");

/* ---------------------------------------------------------- 3. 指南页产物 */

// index.html 是自包含的：运行时按自身地址推导出 init.js 与 bookmarklet，
// 因此无需构建期注入任何 URL，直接原样拷贝即可。
const html = readFileSync(join(ROOT, "index.html"), "utf8");
writeFileSync(join(ROOT, "dist", "index.html"), html);
console.log("[3/3] dist/index.html 写入完成（自包含，无需注入）");
