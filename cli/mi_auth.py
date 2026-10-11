"""通用小米云认证模块（纯标准库，零第三方依赖）。

A1 米家 APP 扫码登录（L1）、免密换 sid 票、RC4/nonce 签名工具、
L3/L4 Miot 客户端。campro（摄像头）与 play2mijia（音响）各存一份，
内容保持一致，改动时请两边同步。票据文件共用同一路径
（~/.cache/campro/mina_qr_auth.json），扫一次码两边都能用。

链路：
  1. QR 登录 sid=mijia：serviceLogin → longPolling/loginUrl → 米家 APP
     扫码 → 长轮询 lp，得到 userId / passToken（无密码、无短信）。
  2. 免密换票：exchange_sid("xiaomiio"/"micoapi", ...) 拿各域 serviceToken。
  3. L3/L4：Miot 类直调 api.io.mi.com（device_list、miotspec prop/action）。

用法：
  from mi_auth import Client, Miot, TOKEN_PATH, load_or_login, _arc4
  auth = load_or_login(need_mico=False)  # 摄像头：只要 xiaomiio 票
  miot = Miot(str(auth["userId"]), auth["xiaomiioServiceToken"],
              auth["xiaomiioSsecurity"])
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import random
import string
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

UA = ("MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; "
      "iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103")

try:
    TOKEN_PATH = Path(__file__).parent / "mina_qr_auth.json"
except NameError:
    TOKEN_PATH = Path.cwd() / "mina_qr_auth.json"

class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))

    def _req(self, url, data=None, cookies=None, timeout=25):
        headers = {"User-Agent": UA}
        if cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(url, data=body, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            print(f"HTTP {e.code} {url}\n{raw}", file=sys.stderr)
            raise

    def cookies(self) -> dict:
        return {c.name: c.value for c in self.jar}


def _strip(text: str) -> dict:
    return json.loads(text.replace("&&&START&&&", ""))


def _rand(n=16) -> str:
    return "".join(random.sample(string.ascii_letters + string.digits, n))


def _build_qr_html(qr_url: str | None, login_url: str | None) -> str:
    """生成一个本地 HTML 展示二维码，返回 file:// URL（纯标准库，零依赖）。

    只用官方下发的 qr 图片地址——绝不把 loginUrl（含登录票据）交给任何第三方
    二维码服务，那等于把票据泄给外人。缺图时页面只展示 loginUrl 文本。
    """
    img_src = qr_url or ""
    esc_img = img_src.replace("&", "&amp;").replace('"', "&quot;")
    esc_login = (login_url or "-").replace("&", "&amp;").replace("<", "&lt;")
    html = (f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">"""
            f"""<title>米家扫码登录</title></head><body style="font-family:sans-serif;text-align:center">"""
            f"""<h2>请用【米家 APP】扫码登录</h2>"""
            f"""{f'<img src="{esc_img}" width="360" height="360" style="border:1px solid #ccc">' if esc_img else '<p>无二维码地址</p>'}"""
            f"""<p style="word-break:break-all;color:#555">{esc_login}</p>"""
            f"""<p>扫完码回到终端继续</p></body></html>""")
    fd, path = tempfile.mkstemp(prefix="mijia_qr_", suffix=".html")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(html)
    return Path(path).as_uri()


def _open_qr_in_browser(qr_url: str | None, login_url: str | None) -> None:
    try:
        page = _build_qr_html(qr_url, login_url)
        webbrowser.open(page)
        print(f"已在浏览器打开二维码：{page}", flush=True)
    except Exception as e:  # 无图形环境等情况只提示，不中断扫码等待
        print(f"打开浏览器失败（可手动访问上面的二维码图片地址）：{e}",
              file=sys.stderr)


def _wait_key_and_open(qr_url: str | None, login_url: str | None,
                       done: threading.Event, timeout: int) -> None:
    """后台等一个任意键（回车亦可），按了就打开浏览器展示二维码。

    主线程在长轮询扫码；本线程只负责“按了就弹浏览器”，扫码结束（done）
    或超时后自动退出，不阻塞主流程。非 tty（如 CI/管道）直接返回。
    """
    try:
        if not sys.stdin.isatty():
            return
    except Exception:
        return
    deadline = time.time() + timeout
    try:
        if os.name == "nt":
            import msvcrt  # noqa: E402

            while time.time() < deadline and not done.is_set():
                if msvcrt.kbhit():
                    msvcrt.getwch()
                    break
                time.sleep(0.1)
            else:
                return
        else:
            import select  # noqa: E402
            import termios  # noqa: E402
            import tty  # noqa: E402

            fd = sys.stdin.fileno()
            old = termios.tcgetattr(fd)
            pressed = False
            try:
                tty.setraw(fd)
                while time.time() < deadline and not done.is_set():
                    r, _, _ = select.select([sys.stdin], [], [], 0.5)
                    if r:
                        os.read(fd, 1)
                        pressed = True
                        break
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
                print(flush=True)  # raw 模式下补个换行，避免提示行错乱
            if not pressed:
                return
    except Exception:
        # raw 单键失败（如 stdin 被重定向中途失效）则退化为“回车即开”
        try:
            input()
        except Exception:
            return
    if done.is_set():
        return
    _open_qr_in_browser(qr_url, login_url)


def qr_login(cli: Client, device_id: str, timeout=120) -> dict:
    r = cli._req("https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia",
                 cookies={"deviceId": device_id, "passToken": "", "userId": ""})
    loc_qs = urllib.parse.parse_qs(urllib.parse.urlparse(_strip(r)["location"]).query)
    params = {k: v[0] for k, v in loc_qs.items()}
    params.update({"_qrsize": "240", "_dc": str(int(time.time() * 1000))})
    login_data = _strip(cli._req("https://account.xiaomi.com/longPolling/loginUrl?"
                                 + urllib.parse.urlencode(params)))
    print("请用【米家 APP】扫码登录（无密码、无短信）：")
    print("二维码图片:", login_data.get("qr"))
    print("扫码内容:", login_data.get("loginUrl"))
    print(f"等待扫码 {timeout}s（按任意键/回车即在浏览器展示二维码，直接扫码可不理）…",
          flush=True)
    _done = threading.Event()
    threading.Thread(target=_wait_key_and_open,
                     args=(login_data.get("qr"), login_data.get("loginUrl"),
                           _done, timeout),
                     daemon=True).start()
    try:
        lp = _strip(cli._req(login_data["lp"], timeout=timeout + 10))
    finally:
        _done.set()
    if lp.get("code") != 0:
        raise RuntimeError(f"扫码登录失败: {lp}")
    auth = {k: lp[k] for k in ("psecurity", "nonce", "ssecurity", "passToken",
                               "userId", "cUserId") if k in lp}
    auth["deviceId"] = device_id
    cli._req(lp["location"])  # 回调落 cookie
    auth.update(cli.cookies())
    auth["savedAt"] = int(time.time())
    return auth


def exchange_sid(sid: str, user_id: str, pass_token: str, device_id: str,
                 cli: Client | None = None) -> tuple[str, str]:
    """用扫码票免密换指定 sid 的 serviceToken，返回 (serviceToken, ssecurity)。"""
    cli = cli or Client()
    r = cli._req(f"https://account.xiaomi.com/pass/serviceLogin?sid={sid}&_json=true",
                 cookies={"deviceId": device_id, "userId": user_id,
                          "passToken": pass_token, "sdkVersion": "3.9"})
    resp = _strip(r)
    if resp.get("code") != 0 or "location" not in resp:
        raise RuntimeError(json.dumps(resp, ensure_ascii=False))
    nsec = f"nonce={resp['nonce']}&{resp['ssecurity']}"
    sign = base64.b64encode(hashlib.sha1(nsec.encode()).digest()).decode()
    cli._req(resp["location"] + "&clientSign=" + urllib.parse.quote(sign))
    token = cli.cookies().get("serviceToken")
    if not token:
        raise RuntimeError(json.dumps(
            {"sid": sid, "cookies": cli.cookies()}, ensure_ascii=False))
    return token, resp["ssecurity"]


def exchange_micoapi(user_id: str, pass_token: str, device_id: str,
                     cli: Client | None = None) -> str:
    """用扫码票免密换 sid=micoapi 的 serviceToken（小爱云 L2 专用）。"""
    token, _ = exchange_sid("micoapi", user_id, pass_token, device_id, cli)
    return token


def _arc4(key: bytes, data: bytes, drop: int = 1024) -> bytes:
    """标准库 RC4（对标 pycryptodome ARC4 + 开头丢 1024 字节）。"""
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    i = j = 0

    def _byte():
        nonlocal i, j
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        return s[(s[i] + s[j]) % 256]

    for _ in range(drop):
        _byte()
    return bytes(b ^ _byte() for b in data)


def _sign_nonce(ssecurity: str, nonce: str) -> str:
    m = hashlib.sha256()
    m.update(base64.b64decode(ssecurity))
    m.update(base64.b64decode(nonce))
    return base64.b64encode(m.digest()).decode()


class Miot:
    """L3/L4：api.io.mi.com + miotspec（device_list、prop/get、action）。"""

    def __init__(self, user_id: str, service_token: str, ssecurity: str,
                 server: str = "https://api.io.mi.com/app"):
        self.cli = Client()
        self.cli.opener.addheaders = [
            ("User-Agent", "iOS-14.4-6.0.103-iPhone12,3--D7744744F7AF32F0544445285880DD63E47D9BE9-8816080-84A3F44E137B71AE-iPhone"),
            ("x-xiaomi-protocal-flag-cli", "PROTOCAL-HTTP2"),
        ]
        self.cookies = {"userId": str(user_id), "serviceToken": service_token}
        self.ssecurity = ssecurity
        self.server = server

    def _call(self, uri: str, payload: dict) -> object:
        data_str = json.dumps(payload, separators=(",", ":"))
        nonce = base64.b64encode(
            os.urandom(8) + int(time.time() / 60).to_bytes(4, "big")).decode()
        snonce = _sign_nonce(self.ssecurity, nonce)
        msg = "&".join([uri, snonce, nonce, "data=" + data_str])
        sig = base64.b64encode(hmac.new(
            base64.b64decode(snonce), msg.encode(), hashlib.sha256).digest()).decode()
        body = {"_nonce": nonce, "data": data_str, "signature": sig}
        raw = self.cli._req(self.server + uri, data=body, cookies=self.cookies)
        resp = json.loads(raw)
        if resp.get("code") != 0:
            raise RuntimeError(json.dumps(resp, ensure_ascii=False))
        result = resp.get("result")
        if isinstance(result, str):  # 部分接口返回 RC4 密文
            result = json.loads(_arc4(base64.b64decode(snonce),
                                      base64.b64decode(result)).decode())
        return result

    def device_list(self) -> list:
        result = self._call("/home/device_list",
                            {"getVirtualModel": True, "getHuamiDevices": 0})
        return result["list"] if isinstance(result, dict) else result

    def action(self, did: str, siid: int, aiid: int, inn: list) -> dict:
        return self._call("/miotspec/action",
                          {"params": {"did": str(did), "siid": siid,
                                      "aiid": aiid, "in": inn}})

    @staticmethod
    def speaker_actions(model: str) -> dict:
        """查 miot-spec.org，找某型号 intelligent_speaker 的 play-text/execute_text_directive 的 siid/aiid。"""
        cli = Client()
        all_models = {i["model"]: i["type"] for i in json.loads(
            cli._req("http://miot-spec.org/miot-spec-v2/instances?status=all"))["instances"]}
        hit = all_models.get(model)
        if hit is None:
            cand = {m: t for m, t in all_models.items() if model in m}
            if len(cand) != 1:
                raise RuntimeError(f"spec 未唯一匹配 {model}: {list(cand)[:5]}")
            hit = list(cand.values())[0]
        inst = json.loads(cli._req("http://miot-spec.org/miot-spec-v2/instance?type=" + hit))
        found = {}
        for s in inst["services"]:
            for a in s.get("actions", []):
                parts = (a.get("type") or "").split(":")
                name = parts[3] if len(parts) > 4 else parts[-1]
                if name in ("play-text", "execute-text-directive"):
                    ins = []
                    for p in a.get("in", []):
                        if isinstance(p, dict):
                            ins.append(p.get("name", p.get("type", "")))
                        else:
                            ins.append(p)  # 老 spec 里 in 是 piid 引用数组
                    found[name] = {"siid": s["iid"], "aiid": a["iid"], "in": ins}
        return found


def load_or_login(force=False, need_mico=False) -> dict:
    """读盘复用扫码票，缺票则扫码；缺域票则增量交换，不重扫。

    need_mico=True 时同时保证 micoapi 票（音响 L2 需要）；
    摄像头只需 xiaomiio 票，默认 False 以省一次换票请求。
    """
    if TOKEN_PATH.exists() and not force:
        auth = json.loads(TOKEN_PATH.read_text())
    else:
        cli = Client()
        device_id = _rand(16).upper()
        auth = qr_login(cli, device_id)
        TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_PATH.write_text(json.dumps(auth, indent=2))
    if need_mico and "micoapiServiceToken" not in auth:
        auth["micoapiServiceToken"] = exchange_micoapi(
            str(auth["userId"]), auth["passToken"], auth["deviceId"], Client())
        TOKEN_PATH.write_text(json.dumps(auth, indent=2))
    if "xiaomiioServiceToken" not in auth:  # L3/L4 需要，按需增量换票，不重扫
        token, ssec = exchange_sid("xiaomiio", str(auth["userId"]),
                                   auth["passToken"], auth["deviceId"], Client())
        auth["xiaomiioServiceToken"] = token
        auth["xiaomiioSsecurity"] = ssec
        TOKEN_PATH.write_text(json.dumps(auth, indent=2))
    return auth
