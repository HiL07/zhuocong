/**
 * rig 页的「兜底看门狗」——**普通脚本**（不是 module），所以一定会执行。
 *
 * 为什么需要它：
 *   rig 页的主体是 ES module（`rig.js`）。如果它因为任何原因**根本没跑起来**
 *   （跨源被拦、CSP、路径错、语法错…），页面上什么都不会发生 —— 用户看到的只是
 *   **一个透明的空窗口**，既没有报错也没有提示（我们踩过：`loadFile` 用 file:// 载 rig 页，
 *   module 从 app:// 导入被 CORS 拦掉，桌宠直接"消失"，日志里连 renderer.ready 都没有）。
 *
 * 做法：3 秒后检查 `window.__rigDiag`。module 成功时会立刻给它赋值。
 *   没赋值 ⇒ 在页面上写清楚原因 + 怎么回退（改 config.pet.renderer = "frames"）。
 */
;(function () {
  var WAIT = 3000
  setTimeout(function () {
    if (window.__rigDiag) return            // module 跑起来了，什么都不用做
    var el = document.getElementById('fallback')
    if (!el) return
    el.style.display = 'flex'
    el.style.whiteSpace = 'pre-wrap'
    el.textContent =
      'rig 没能启动（3 秒内没有初始化）。\n' +
      '最常见原因：页面不是通过 app:// 加载的（必须是 app://pet/renderer/rig.html）。\n' +
      '临时回退：把 config/default.json 里的 pet.renderer 改成 "frames"。'
    try { console.error('[rig-guard] rig.js 未初始化') } catch (e) { /* ignore */ }
  }, WAIT)
})()
