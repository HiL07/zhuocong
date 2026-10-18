"use strict";
/**
 * `app://` 协议 —— 给「原版 rig」渲染路线喂文件。
 *
 * 【为什么非要这个协议】
 *   `vendor/coopanion/**` 是 **ES module**（`import`/`export`）。
 *   我们的桌宠窗是 `win.loadFile(...)`（`file://`），而 **Chromium 在 file:// 下会以 CORS
 *   拦掉 ES module**（这正是本项目决策 D1「不上打包器、用普通 <script>」的由来）。
 *   所以要么起本地 http 服务，要么注册一个特权 scheme —— 我们选后者：
 *   不占端口、不需要联网、不会被防火墙盯上。
 *
 * 【一个 origin 装三样东西】
 *   app://pet/renderer/*  →  <项目>/renderer/*            （我们自己的页面）
 *   app://pet/vendor/*    →  <项目>/vendor/coopanion/*    （上游 kit + 形象包，AGPL）
 *   app://pet/assets/*    →  <项目>/assets/raw/coopanion-whale/*  （贴图，复用现有素材）
 *
 *   ⚠️ 必须在 `app.whenReady()` **之前**调用 `registerRigScheme()`：
 *      `standard/secure/supportFetchAPI` 是 ES module 能被加载、`fetch()` 能用的前提，
 *      等 ready 之后再注册就晚了。
 *   ⚠️ 只读白名单式映射：不在 MAP 前缀里的路径一律 404，**不允许 `..` 逃逸**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RIG_ORIGIN = exports.RIG_SCHEME = void 0;
exports.registerRigScheme = registerRigScheme;
exports.handleRigProtocol = handleRigProtocol;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
exports.RIG_SCHEME = 'app';
exports.RIG_ORIGIN = `${exports.RIG_SCHEME}://pet/`;
/** 注册特权 scheme（必须在 app ready 之前） */
function registerRigScheme() {
    electron_1.protocol.registerSchemesAsPrivileged([
        {
            scheme: exports.RIG_SCHEME,
            privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
        }
    ]);
}
/**
 * 挂上请求处理（app ready 之后）。
 * @param root 项目根目录（开发期 = app.getAppPath()）
 */
function handleRigProtocol(root) {
    const map = [
        ['/renderer/', (0, node_path_1.join)(root, 'renderer')],
        ['/vendor/', (0, node_path_1.join)(root, 'vendor', 'coopanion')],
        ['/assets/', (0, node_path_1.join)(root, 'assets', 'raw', 'coopanion-whale')],
        // 互动小说小游戏：`app://pet/game/backrooms-return.html`
        // ⚠️ 必须走这个协议而不是 file:// —— 游戏用 localStorage 存档，
        //    file:// 与 app:// 是不同 origin，换加载方式进度就"消失"了。
        ['/game/', (0, node_path_1.join)(root, 'assets', 'games')]
    ];
    const roots = map.map(([prefix, dir]) => [prefix, (0, node_path_1.normalize)(dir)]);
    electron_1.protocol.handle(exports.RIG_SCHEME, (req) => {
        let pathname = '/';
        try {
            pathname = decodeURIComponent(new URL(req.url).pathname);
        }
        catch {
            return new Response('bad url', { status: 400 });
        }
        for (const [prefix, dir] of roots) {
            if (!pathname.startsWith(prefix))
                continue;
            const rel = pathname.slice(prefix.length);
            const file = (0, node_path_1.normalize)((0, node_path_1.join)(dir, rel));
            // 防目录穿越：结果必须仍在白名单目录内
            if (!file.startsWith(dir.endsWith(node_path_1.sep) ? dir : dir + node_path_1.sep)) {
                return new Response('forbidden', { status: 403 });
            }
            if ((0, node_fs_1.existsSync)(file) && (0, node_fs_1.statSync)(file).isFile()) {
                return electron_1.net.fetch((0, node_url_1.pathToFileURL)(file).toString());
            }
            return new Response(`not found: ${prefix}${rel}`, { status: 404 });
        }
        return new Response(`not found: ${pathname}`, { status: 404 });
    });
}
