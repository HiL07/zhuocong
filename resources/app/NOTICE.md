# 第三方组件与来源说明（NOTICE）

本程序（桌宠宿主）使用了以下第三方作品。分发本程序时**必须**连同本文件与 `LICENSES/` 目录一起提供。

---

## 1. Coopanion（角色渲染器 + 素材）

- **用途**：角色实时渲染（`vendor/coopanion/`）与鲸鱼娘角色素材（`assets/raw/coopanion-whale/`）
- **来源**：<https://github.com/Pal-AI-Lab/Coopanion>（上游公开仓库）
- **许可**：**GNU Affero General Public License v3.0 or later**，附一项额外许可
  （仅覆盖 Steamworks 相关部分）。全文见 `LICENSES/Coopanion-AGPL-3.0.txt`，
  上游附加说明见 `LICENSES/Coopanion-NOTICE.md`。
- **我们对上游做了什么改动**（AGPL 要求说明）：
  1. 把 `web/kit/{rig.js,body.js}` 与 `web/whale/{figure.js,figure.json,model.json,thumbs/*}` 复制进 `vendor/coopanion/`
     （**未修改上游代码**，仅做路径接入）；
  2. 我们自己的页面 `renderer/rig.html` + `renderer/rig.js` 作为宿主，通过
     `app://` 协议加载这些文件，并用 `figure` 的 `asset` 选项把上游的 `tex/`、`feat/` 路径
     重映射到我们扁平的素材目录（映射逻辑在我们自己的代码里，不在上游代码里）。
  3. 颜色/服装方案通过上游的 `setScheme` 切换，未改动其调色板定义。

### 源码如何获取（AGPL 合规关键）

GPL/AGPL 允许分发二进制，但**必须提供对应源码**。本仓库即为源码：分发本程序时，
请同时给出本仓库地址（或随包附带源码压缩包）。**仓库里就包含上述全部源码与素材**，
无需额外获取。

---

## 2. Electron

- **用途**：桌面应用运行时
- **许可**：MIT
- 附带 `LICENSES/Electron-LICENSE.txt`（若存在），否则见 <https://github.com/electron/electron/blob/main/LICENSE>

## 3. DSH 运行时（可选，仅当内置 Python 时）

- 本项目语音功能调用 Python：TTS 使用 `edge-tts`，语音识别使用 `faster-whisper`。
- `edge-tts`：LGPL-3.0；`faster-whisper`：MIT；`PyTorch`（若用本地 TTS）：BSD-3-Clause。
- 音频由**微软 Edge 的神经语音服务**合成（非官方客户端）⇒ **仅供个人使用**；
  若要对外正式分发，请改用本地模型（GPT-SoVITS / CosyVoice）作为默认引擎。

## 4. 字体

- 不打包任何字体文件；界面使用系统中文字体栈（思源宋体/微软雅黑/PingFang 等）。

---

## 5. 数据流向（隐私声明）

| 功能 | 数据去哪 |
|---|---|
| 聊天 | DeepSeek API（`api.deepseek.com`），仅发送对话内容 |
| 看屏幕（👁，默认关闭） | 截图**经你手动触发**才抓，压缩后随问题发给 DeepSeek 多模态模型；**不落盘** |
| 语音合成 | 默认 edge-tts ⇒ 文本发往微软语音服务；切到 GPT-SoVITS 则**全本地** |
| 语音识别 | 全本地（faster-whisper） |
| 其他 | 无遥测、无统计上报 |

---

_本文件由项目维护者维护；若你新增了第三方资源，请在此追加一节。_
