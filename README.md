# play to mijia

stream your $url music on mijia smart speakers

## 布局

- `poc/qr_mina_play.py` — 米家 APP 扫码 → 小爱云播 HTTP 媒体（`--list/--play/--tts/--tts2`），纯标准库
- `poc/mi_auth.py` — 通用认证（扫码/换票/RC4/Miot），与 campro 的同名文件保持同步，票据共用 `~/.cache/campro/mina_qr_auth.json`
- `docs/xiaomi-speaker-research.md` — API 体系调研（L1–L5）与实测记录
- `thirdparty/xiaogpt` — 小爱 GPT 探针（上游开源项目，仅作协议参考）
- `mijia-api/` + `demo.py` — 米家 IoT 云 API 封装与示例（早前已在此仓库）


https://github.com/yihong0618/xiaogpt
https://github.com/Do1e/mijia-api

