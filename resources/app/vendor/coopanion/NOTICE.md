# 第三方代码说明（vendor/coopanion/）

这个目录**不是我们的代码**。它是上游开源项目的原样副本，用于本项目「实时 rig 渲染」路线。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/Pal-AI-Lab/Coopanion> |
| 包路径 | `packages/cortico-world-desktop-pet/` |
| 许可 | **GNU AGPL-3.0-or-later**（全文见同目录 `LICENSE`；附加许可只覆盖 Valve Steamworks SDK 链接，与我们无关） |
| 本机来源副本 | `<工作区>/Tools/Coopanion/Coopanion-main/`（codeload 整包下载） |
| 同步时间 / 文件 md5 | 见同目录 `VENDOR-LOCK.json` |

## 这里有什么

```
vendor/coopanion/
├── LICENSE                 ← 上游 AGPL 全文（**必须随分发一起给**）
├── VENDOR-LOCK.json        ← 同步时间 + 每个文件的 md5（对账用）
└── web/
    ├── kit/rig.js          ← WebGL sprite rig（预乘 alpha、GLSL ES 1.00、webgl2→webgl1 回退）
    ├── kit/body.js         ← 身体状态机：走/跑/跳/坐/睡/被拎起/甩出去/28 种表情/口型/倾听/思考
    └── whale/
        ├── figure.js       ← 「大肥鱼」形象包（画法 + 弹簧物理 + 实时脸贴图）
        ├── figure.json     ← 形象包声明（配色轴、服装轴、缩略图）
        ├── model.json      ← 部件/枢轴/变形器几何
        └── thumbs/*.png    ← 8 套配色 + 2 套服装的缩略图（选择界面用）
```

## ⚠️ 我们**没有**复制贴图（故意的）

上游 `web/whale/tex|feat/*.png`（50 张）与 7 套配色的贴图，
与我们 `assets/raw/coopanion-whale/` 里的同名文件**逐张 md5 相同**（实测 50/50、方案抽查 25/25）。
⇒ 不复制第二份，避免两份贴图以后各自漂移；运行时用 figure 的 `opts.asset` 做路径映射：

```js
// 上游期望 tex/X.png、feat/X.png、schemes/<id>/tex|feat/X.png；我们的素材是扁平目录
const asset = (p) => {
  const s = String(p).replace(/^\.?\//, '')
  if (s === 'model.json') return new URL('app://assets/coopanion-whale/model.json')
  if (s.startsWith('schemes/')) return new URL('app://assets/coopanion-whale/' + s)   // 结构与上游一致
  return new URL('app://assets/coopanion-whale/' + s.replace(/^(tex|feat)\//, ''))    // 扁平：去掉前缀
}
const figure = await createWhaleFigure(base, { asset, scheme: 'deepseek' })
```

> `tex/` 与 `feat/` 之间**没有同名文件**（实测），所以"去掉前缀"的扁平映射是安全的。

## 我们改了什么

**什么都没改。** `figure.js` / `figure.json` / `model.json` / `kit/*` 全部原样；
上游版本比我们本地那份 `assets/raw/coopanion-whale/figure.js` **更新**
（上游多了「走路时手臂摆动」的修正，831 行 vs 835 行）⇒ **以这里为准**。

## 怎么再同步（上游更新时）

```powershell
# 1) 重新拉上游整包（codeload 可用，不吃 GitHub API 限额）
#    见 docs/review-asset-route.md §3.1
# 2) 同步到 vendor（默认 dry-run，先看清单）
& $py "tools/sync_vendor_coopanion.py"
& $py "tools/sync_vendor_coopanion.py" --apply
```

## 分发时的义务（AGPL）

只要你把包含这些文件的东西**发给别人**（包括发给朋友、上传网盘），就必须：
1. 附上 `LICENSE` 全文（我们的分享包已自动带上 `THIRD-PARTY/Coopanion-LICENSE.txt`）；
2. 在被要求时提供**相应源码**（上游源码公开，指向仓库即可；我们自己改过的部分也要给）。
