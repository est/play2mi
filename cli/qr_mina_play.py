"""最小 PoC：米家 APP 扫码（无密码/无短信）→ 换 micoapi 票 → 音响播指定 HTTP 媒体。

纯标准库（urllib/http.cookiejar），零第三方依赖。
通用认证（Client/扫码/换票/RC4/Miot）复用 poc/mi_auth.py，
本文件只留小爱云 L2（Mina/ubus 播音）专属逻辑。

链路：
  1. L1-A1 扫码票复用：mi_auth.load_or_login(need_mico=True)，不碰密码。
  2. L2 小爱云：GET /admin/v2/device_list → POST /remote/ubus 播 URL。
     新固件 player_play_url，不行 fallback player_play_music。
  3. L4 兜底：miot play-text（ubus text_to_speech 哑巴时机型用）。

用法：
  python3 poc/qr_mina_play.py --list
  python3 poc/qr_mina_play.py --play https://host/x.mp3 --did <deviceID>
  python3 poc/qr_mina_play.py --tts "你好" --did <deviceID>

token 存 ~/.cache/campro/mina_qr_auth.json（与 campro 共用同一票据，扫一次码两边都能用），不存密码。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from mi_auth import Client, Miot, _rand, load_or_login  # noqa: E402

USE_PLAY_MUSIC_API = {"LX04", "LX05", "L05B", "L05C", "L06", "L06A", "X08A", "X10A",
                      "X08C", "X08E", "X8F", "X4B", "OH2", "OH2P", "X6A"}


class Mina:
    def __init__(self, user_id: str, service_token: str):
        self.cli = Client()
        self.cookies = {"userId": str(user_id), "serviceToken": service_token}
        self._hw: dict[str, str] = {}

    def _get(self, uri: str, params: dict) -> dict:
        params = dict(params, requestId="app_ios_" + _rand(30))
        url = f"https://api2.mina.mi.com{uri}?" + urllib.parse.urlencode(params)
        return json.loads(self.cli._req(url, cookies=self.cookies))

    def _post(self, uri: str, params: dict) -> dict:
        params = dict(params, requestId="app_ios_" + _rand(30))
        return json.loads(self.cli._req(f"https://api2.mina.mi.com{uri}", data=params,
                                        cookies=self.cookies))

    def device_list(self) -> list:
        return self._get("/admin/v2/device_list", {"master": 0}).get("data") or []

    def ubus(self, did: str, method: str, path: str, msg: dict) -> dict:
        return self._post("/remote/ubus", {"deviceId": did, "method": method,
                                           "path": path, "message": json.dumps(msg)})

    def tts(self, did: str, text: str) -> dict:
        return self.ubus(did, "text_to_speech", "mibrain", {"text": text})

    def player_stop(self, did: str) -> dict:
        return self.ubus(did, "player_play_operation", "mediaplayer",
                         {"action": "stop", "media": "app_ios"})

    def player_set_volume(self, did: str, volume: int) -> dict:
        return self.ubus(did, "player_set_volume", "mediaplayer",
                         {"volume": volume, "media": "app_ios"})

    def player_get_status(self, did: str) -> dict:
        return self.ubus(did, "player_get_play_status", "mediaplayer",
                         {"media": "app_ios"})

    def play_url(self, did: str, url: str, type_=2) -> dict:
        if self._hardware(did) in USE_PLAY_MUSIC_API:
            return self.play_music_url(did, url, type_)
        r = self.ubus(did, "player_play_url", "mediaplayer",
                      {"url": url, "type": type_, "media": "app_ios"})
        if (r.get("data") or {}).get("code") not in (None, 0):
            return self.play_music_url(did, url, type_)
        return r

    def play_music_url(self, did: str, url: str, type_=2) -> dict:
        music = {"payload": {"audio_type": "MUSIC" if type_ == 1 else "",
                             "audio_items": [{"item_id": {"audio_id": "1582971365183456177",
                                                          "cp": {"album_id": "-1", "episode_index": 0,
                                                                 "id": "355454500", "name": "xiaowei"}},
                                               "stream": {"url": url}}],
                             "list_params": {"listId": "-1", "loadmore_offset": 0,
                                             "origin": "xiaowei", "type": "MUSIC"}},
                 "play_behavior": "REPLACE_ALL"}
        return self.ubus(did, "player_play_music", "mediaplayer",
                         {"startaudioid": "1582971365183456177",
                          "music": json.dumps(music)})

    def _hardware(self, did: str) -> str:
        if did not in self._hw:
            for h in self.device_list():
                if h.get("deviceID"):
                    self._hw[h["deviceID"]] = h.get("hardware", "")
        return self._hw.get(did, "")


def unified_list(mina: Mina, miot: Miot | None) -> list:
    """合并 L2（小爱云）与 L3（IoT 云）设备表，按 miotDID 对齐。

    主账号：两边都有；子账号：只有 L3 行（L2 的 --did 为空，不可 --play，
    但 miotDID 可 --tts2）。
    """
    mina_devs = mina.device_list()
    miot_devs = miot.device_list() if miot is not None else []
    rows, seen = [], set()
    for d in mina_devs:
        mdid = str(d.get("miotDID") or "")
        seen.add(mdid)
        rows.append({"name": d.get("alias") or d.get("name"),
                     "hw": d.get("hardware", ""),
                     "did": d.get("deviceID"), "miot": mdid or "-",
                     "shared": "no"})
    for e in miot_devs:
        mdid = str(e.get("did"))
        if mdid in seen:
            continue
        rows.append({"name": e.get("name"), "hw": e.get("model", ""),
                     "did": "-", "miot": mdid,
                     "shared": "yes" if e.get("shareFlag") else "no"})
    return rows


def resolve_miot_did(devs: list, miot: Miot, did: str | None,
                     explicit: str | None) -> str | None:
    if explicit:
        return explicit
    if did:
        for d in devs:  # 主账号：L2 deviceID → miotDID
            if d.get("deviceID") == did and d.get("miotDID"):
                return str(d["miotDID"])
        try:  # 子账号：--did 直接就是 miot 侧 did
            if any(str(e.get("did")) == str(did) for e in miot.device_list()):
                return str(did)
        except Exception:
            pass
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="扫码登录小爱云并播放 HTTP 媒体（零依赖 PoC）")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--did")
    ap.add_argument("--play", metavar="URL")
    ap.add_argument("--tts", metavar="TEXT")
    ap.add_argument("--tts2", metavar="TEXT",
                    help="L4 TTS：miot play-text（ubus text_to_speech 哑巴时机型用）")
    ap.add_argument("--miot-did", help="miot 侧 did（默认按 --did 自动映射 miotDID）")
    ap.add_argument("--miot-discover", action="store_true",
                    help="只查该型号 spec 的 play-text/execute_text_directive 定义")
    ap.add_argument("--stop", action="store_true", help="先停掉在播音乐再执行")
    ap.add_argument("--volume", type=int, metavar="0-100", help="执行前设置音量")
    ap.add_argument("--status", action="store_true", help="查询播放状态")
    ap.add_argument("--dump-dev", action="store_true", help="打印本机 device_list 完整条目（含硬件/能力）")
    ap.add_argument("--relogin", action="store_true")
    args = ap.parse_args(argv)

    auth = load_or_login(force=args.relogin, need_mico=True)
    mina = Mina(str(auth["userId"]), auth["micoapiServiceToken"])
    devs = mina.device_list()

    def _miot_or_none() -> Miot | None:
        try:
            return Miot(str(auth["userId"]), auth["xiaomiioServiceToken"],
                        auth["xiaomiioSsecurity"])
        except KeyError:
            return None

    if args.list or not (args.play or args.tts or args.tts2
                         or args.status or args.dump_dev or args.miot_discover):
        for r in unified_list(mina, _miot_or_none()):
            print(f"{r['name']} | hw={r['hw']} | did={r['did']} | "
                  f"miot={r['miot']} | shared={r['shared']}")
        print("--play/--tts 用 did 列；--tts2 用 miot 列 "
              "(did 为 - 表示子账号无 L2，只能 tts2)", file=sys.stderr)
        return 0
    if not args.did:
        print("缺 --did，先 --list 选一台", file=sys.stderr)
        return 2
    if args.volume is not None:
        print("set_volume:", json.dumps(
            mina.player_set_volume(args.did, args.volume), ensure_ascii=False))
    if args.stop or args.tts:
        # TTS 不会打断音乐流：先 stop，否则 TTS 下发成功也听不见；
        # 云端是异步代发，停完等 2s 再播，避免 TTS 被旧流状态吞掉
        print("stop:", json.dumps(
            mina.player_stop(args.did), ensure_ascii=False), flush=True)
        if args.tts:
            time.sleep(2)
    if args.dump_dev:
        for d in devs:
            if d.get("deviceID") == args.did:
                print("device:", json.dumps(d, ensure_ascii=False))
                break
        else:
            print("device: 未在 device_list 中找到该 did", file=sys.stderr)
    if args.status:
        print("status:", json.dumps(
            mina.player_get_status(args.did), ensure_ascii=False))
    if args.tts:
        print("tts:", json.dumps(mina.tts(args.did, args.tts), ensure_ascii=False))
    if args.tts2 or args.miot_discover:
        miot = Miot(str(auth["userId"]), auth["xiaomiioServiceToken"],
                    auth["xiaomiioSsecurity"])
        mdid = resolve_miot_did(devs, miot, args.did, args.miot_did)
        if not mdid:
            raise RuntimeError(json.dumps(
                {"want": args.did, "mina_devs": devs}, ensure_ascii=False))
        model = next((e.get("model", "") for e in miot.device_list()
                      if str(e.get("did")) == str(mdid)), "")
        print("model:", model, "miotDID:", mdid, flush=True)
        acts = Miot.speaker_actions(model)
        print("actions:", json.dumps(acts, ensure_ascii=False), flush=True)
        if args.tts2 and not args.miot_discover:
            if "play-text" not in acts:
                print("该型号无 play-text，无法 L4 TTS", file=sys.stderr)
                return 3
            a = acts["play-text"]
            print("tts2:", json.dumps(
                miot.action(mdid, a["siid"], a["aiid"], [args.tts2]),
                ensure_ascii=False))
    if args.play:
        print("play:", json.dumps(mina.play_url(args.did, args.play), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
