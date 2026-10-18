"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeWindowSize = computeWindowSize;
exports.loadRigPage = loadRigPage;
exports.loadFramesPage = loadFramesPage;
exports.watchRigReady = watchRigReady;
exports.switchRenderer = switchRenderer;
exports.createPetWindow = createPetWindow;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
/**
 * 算窗口尺寸。
 * 有角色帧尺寸且开了 fitToPet 时，窗口收紧到「帧尺寸 + 四周 padding + 顶部气泡预留」，
 * 这样桌宠在桌面上占的面积才和角色本身相当（否则 256x256 的画布会让窗口白白大一圈）。
 */
function computeWindowSize(cfg, frameSize) {
    const w = cfg.window;
    if (!w.fitToPet || !frameSize) {
        return { width: w.width, height: w.height, fitted: false };
    }
    return {
        width: Math.max(96, frameSize.width + w.padding * 2),
        height: Math.max(96, frameSize.height + w.padding * 2 + w.bubbleSpace),
        fitted: true
    };
}
/**
 * 载入 rig 页（走 app://）。
 * `baseHeight` = **气泡展开前**的窗口高度，页面用它锁住角色缩放
 * （主进程显示多行气泡时会把窗口向上撑高；若页面用实时高度算缩放，角色会被放大 —— 踩过）。
 */
function loadRigPage(win, cfg, baseHeight) {
    const q = new URLSearchParams({
        scheme: cfg.pet.scheme ?? 'deepseek',
        scale: String(cfg.pet.rigScale),
        baseh: String(baseHeight)
    });
    void win.loadURL(`app://pet/renderer/rig.html?${q.toString()}`);
}
/** 载入旧帧页（file:// 即可，它用的是普通 <script>，不涉及 ES module）。 */
function loadFramesPage(win) {
    void win.loadFile((0, node_path_1.join)(__dirname, '..', '..', 'renderer', 'index.html'));
}
/**
 * rig 页的自诊断 + 自动回退（**产品级兜底**）。
 *
 * 为什么必须有：rig 起不来时窗口是**透明的** —— 用户看到的是"桌宠消失"，日志里也只有一个
 * `window.created`、没有 `renderer.ready`（我们就是这么发现问题的）。
 * 6 秒后探一次页面里的 `__rigDiag`：
 *   · ok   → 记 `rig.ready`（带 scheme/frames/size，方便对账）
 *   · 不 ok → 记 `rig.notReady`（带页面自己报的错）并**自动退回 PNG 帧**，至少让用户看到形象
 */
function watchRigReady(win) {
    setTimeout(() => {
        if (win.isDestroyed())
            return;
        void win.webContents
            .executeJavaScript('({ ok: !!(window.__rigDiag && window.__rigDiag.ok), diag: window.__rigDiag || null, err: (window.__rigDiag && window.__rigDiag.err) || null })')
            .then((r) => {
            if (r?.ok) {
                (0, logger_1.log)('rig.ready', r.diag);
                return;
            }
            (0, logger_1.log)('rig.notReady', { err: r?.err ?? null, fallback: 'frames' });
            loadFramesPage(win);
        })
            .catch((e) => {
            (0, logger_1.log)('rig.probeFailed', { error: String(e).slice(0, 300) });
            loadFramesPage(win);
        });
    }, 6000);
}
/**
 * 运行时切换渲染路线（托盘菜单用，**不重启**）。
 * 注意：这是**会话内**切换，不写回配置文件 —— 重启后仍以 `config.pet.renderer` 为准。
 * 想永久生效，改 config 里的那一个字段。
 */
function switchRenderer(win, cfg, kind, baseHeight) {
    (0, logger_1.log)('renderer.switch', { to: kind, baseHeight });
    if (kind === 'rig') {
        loadRigPage(win, cfg, baseHeight);
        watchRigReady(win);
    }
    else {
        loadFramesPage(win);
    }
}
function createPetWindow(cfg, profile, frameSize) {
    const { workArea } = electron_1.screen.getPrimaryDisplay();
    const { width, height, fitted } = computeWindowSize(cfg, frameSize);
    const { marginRight, marginBottom } = cfg.window;
    const x = Math.round(workArea.x + workArea.width - width - marginRight);
    const y = Math.round(workArea.y + workArea.height - height - marginBottom);
    const win = new electron_1.BrowserWindow({
        width,
        height,
        x,
        y,
        transparent: true,
        frame: false,
        resizable: false,
        movable: true,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        alwaysOnTop: cfg.window.alwaysOnTop,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        show: false,
        focusable: true,
        title: 'DSH 桌宠',
        webPreferences: {
            preload: (0, node_path_1.join)(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    win.setMenuBarVisibility(false);
    // ★ 渲染层诊断：把页面的报错/加载失败写进日志（.local/log.ndjson）
    //   为什么需要：rig 页出问题时窗口是**透明的**，屏幕上什么都看不见；
    //   没有这几行，排查就只剩"看不到"（我们踩过：日志里只有 window.created、没有 renderer.ready）。
    win.webContents.on('console-message', (...a) => {
        const e = a[0];
        const level = typeof a[1] === 'number' ? a[1] : e?.level;
        const message = typeof a[2] === 'string' ? a[2] : e?.message;
        // 只记 warning 以上，免得把正常日志刷满
        if (level === 2 || level === 3 || String(level) === 'warning' || String(level) === 'error') {
            (0, logger_1.log)('renderer.console', { level, message: String(message).slice(0, 400) });
        }
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        (0, logger_1.log)('renderer.loadFailed', { code, desc, url: String(url).slice(0, 200) });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        (0, logger_1.log)('renderer.gone', { reason: details?.reason });
    });
    win.once('ready-to-show', () => {
        // Profile B/C 延迟 150ms 显示，规避首帧黑底
        if (profile === 'A')
            win.show();
        else
            setTimeout(() => win.show(), 150);
    });
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    // ★ 渲染路线开关（M2b）：'rig' = 上游原版实时 rig；'frames' = 原来的预烘焙 PNG 帧
    //   ⚠️ 两条路都保留，改 config.pet.renderer 就能回退（默认见 config/default.json）；
    //      运行时也能从托盘一键切换（见 index.ts 的 renderer.toggle），不用重启。
    const useRig = cfg.pet.renderer === 'rig';
    const page = useRig ? 'rig.html' : 'index.html';
    if (devUrl) {
        void win.loadURL(devUrl.replace(/\/$/, '') + '/' + page);
    }
    else if (useRig) {
        loadRigPage(win, cfg, height);
        watchRigReady(win);
    }
    else {
        // 渲染层是项目根的静态目录（无打包器）：out/main → ../../renderer/index.html
        void win.loadFile((0, node_path_1.join)(__dirname, '..', '..', 'renderer', page));
    }
    if (cfg.window.ignoreMouseByDefault) {
        win.setIgnoreMouseEvents(true, { forward: true });
    }
    (0, logger_1.log)('window.created', {
        profile,
        bounds: win.getBounds(),
        fittedToPet: fitted,
        frameSize: frameSize ?? null,
        transparent: true,
        frame: false,
        alwaysOnTop: cfg.window.alwaysOnTop,
        ignoreMouse: cfg.window.ignoreMouseByDefault
    });
    return win;
}
