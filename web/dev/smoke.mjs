#!/usr/bin/env node
/* ============================================================================
 * play2xiaomi · dev/smoke.mjs —— 零网络冒烟测试
 *
 * 干什么：不联网，用"可替换的 fetch 实现"验证 core.js 的请求构造与协议逻辑
 *   1. Mina.deviceList / ubus / play_url fallback（对照 python 版行为）
 *   2. TTS / play_music 的 message JSON 载荷
 *   3. 登录页常量（登录交由小米官方页，不再自建扫码流程）
 *
 * 用法：node dev/smoke.mjs
 * ========================================================================== */
"use strict";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
await import("file://" + join(ROOT, "..", "src", "core.js"));
const C = globalThis.Play2xiaomi;
assert.ok(C, "core.js 应挂出 globalThis.Play2xiaomi");

/* ---------------- 1. 请求构造：拦截 _fetchImpl，比对 URL 与 body ---------------- */

let calls = [];
C._fetchImpl = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  // 每次调用返回一个可识别的最小 JSON（device_list 也可返回 {code:0, data:[]}）
  const body = calls.length === 1
    ? { code: 0, message: "Success", data: [
        { deviceID: "did-A", hardware: "LX06", alias: "小爱触屏", miotDID: "1" },
        { deviceID: "did-B", hardware: "LX04", alias: " bedside", miotDID: "2" },
      ] }
    : { code: 0, message: "Success", data: { code: 0 } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const mina = new C.Mina();

// device_list：requestId 应为 app_ios_+随机串；master=0
calls = [];
const devs = await mina.deviceList();
assert.equal(devs.length, 2);
assert.match(calls[0].url, /^https:\/\/api2\.mina\.mi\.com\/admin\/v2\/device_list\?/);
assert.match(calls[0].url, /master=0/);
assert.match(calls[0].url, /requestId=app_ios_[A-Za-z0-9]{30}/);

// did-B（LX04 命中 USE_PLAY_MUSIC_API）：先 device_list 取 hardware，再直接 player_play_music
calls = [];
await mina.playUrl("did-B", "http://example.com/x.mp3");
assert.equal(calls.length, 2, "LX04 命中 USE_PLAY_MUSIC_API，不应先试 play_url");
assert.match(calls[0].url, /device_list/);
assert.match(calls[1].url, /remote\/ubus/);
const ubusBodyB = new URLSearchParams(calls[1].opts.body);
assert.equal(ubusBodyB.get("method"), "player_play_music");

// did-A（LX06，不在列）：整张设备表已缓存，直接 player_play_url
calls = [];
await mina.playUrl("did-A", "http://example.com/y.mp3");
assert.equal(calls.length, 1);
assert.equal(new URLSearchParams(calls[0].opts.body).get("method"), "player_play_url");

// fallback 行为：play_url 返回非 0 data.code → 应再发 player_play_music
// （did-A 的 hardware 上一步已缓存，故不会再拉 device_list）
C._fetchImpl = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  return {
    ok: true, status: 200,
    text: async () => {
      if (/device_list/.test(String(url))) {
        return JSON.stringify({ code: 0, data: [{ deviceID: "did-A", hardware: "LX06" }] });
      }
      return JSON.stringify({ code: 0, message: "Success", data: { code: 8051 } });
    },
  };
};
calls = [];
await mina.playUrl("did-A", "http://example.com/z.mp3");
assert.equal(calls.length, 2, "play_url + play_music fallback（无 device_list 缓存命中）");
assert.equal(new URLSearchParams(calls[1].opts.body).get("method"), "player_play_music");
const msg = JSON.parse(new URLSearchParams(calls[1].opts.body).get("message"));
const musicMsg = JSON.parse(msg.music); // ubus.message 再包一层（对照 python 版结构）
assert.equal(msg.startaudioid, "1582971365183456177");
assert.equal(musicMsg.payload.audio_items[0].stream.url, "http://example.com/z.mp3");
assert.equal(musicMsg.play_behavior, "REPLACE_ALL");

// TTS / stop / volume 的 ubus 形状
calls = [];
await mina.tts("did-A", "你好");
await mina.stop("did-A");
await mina.setVolume("did-A", 40);
assert.equal(new URLSearchParams(calls[0].opts.body).get("method"), "text_to_speech");
assert.equal(JSON.parse(new URLSearchParams(calls[0].opts.body).get("message")).text, "你好");
assert.equal(JSON.parse(new URLSearchParams(calls[1].opts.body).get("message")).action, "stop");
assert.equal(JSON.parse(new URLSearchParams(calls[2].opts.body).get("message")).volume, 40);

/* ---------------- 2. stripXiaomi / rand ---------------- */
assert.deepEqual(C.stripXiaomi('&&&START&&&{"code":0}'), { code: 0 });
assert.equal(C.rand(16).length, 16);
assert.ok(new Set(C.rand(30).split("")).size === 30, "rand 不放回抽样");

/* ---------------- 3. 登录交给官方页 ----------------
 * 自定义扫码/换票已移除（CORS 走不通），登录直接用官方页：
 * https://account.xiaomi.com/pass/serviceLogin?sid=micoapi（回调 .mina.mi.com/sts）。
 */
assert.match(C.LOGIN_PAGE, /^https:\/\/account\.xiaomi\.com\/pass\/serviceLogin\?sid=micoapi$/);

console.log("✅ smoke 全部通过：device_list / play_url fallback / ubus 载荷 / stripXiaomi·rand / LOGIN_PAGE");
