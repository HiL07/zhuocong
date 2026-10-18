"use strict";
/**
 * 通关结算窗（B1）。
 *
 * 设计取舍：**不改游戏的结局页**。游戏自己的 `scr-end` 已经把三种结局的正文写得很完整
 * （good「回到现实」/ warm「回到家了」/ bad「我们两不相欠」），
 * 所以我们只在它外面补一层"数据 + 出口"：
 *   · 数据：原石几颗 / 暗了几颗 / 亲和档位 / 受过几次伤 / 救没救人 / 玩了多久
 *   · 出口：`[再玩一次]`（清档重开）与 `[回到桌面]`（关窗 + 桌宠说一句收尾）
 *
 * 为什么不直接改它的结局页：以后作者更新游戏时，我们的改动会冲突；
 * 而结算数据我们本来就要从 `S` 里算，放外面更干净。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.THEME_LINE = void 0;
exports.openFinishWindow = openFinishWindow;
exports.closeFinishWindow = closeFinishWindow;
exports.finishWindowOpen = finishWindowOpen;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
let win = null;
let current = null;
let deps = null;
let wired = false;
const TITLES = {
    good: { kicker: 'GOOD ENDING', title: '回到现实' },
    warm: { kicker: 'GOOD ENDING · 余温', title: '回到家了' },
    bad: { kicker: 'BAD ENDING', title: '我们两不相欠' }
};
/** 主题句：金发旅人说的那句话，原样出现一次（用户要求） */
exports.THEME_LINE = '要善待身边的人。';
function wire() {
    if (wired)
        return;
    wired = true;
    electron_1.ipcMain.handle('finish:data', () => {
        const s = current;
        if (!s)
            return null;
        const meta = TITLES[s.endKind] ?? TITLES.good;
        return {
            ...s,
            kicker: meta.kicker,
            title: meta.title,
            theme: exports.THEME_LINE,
            elapsedText: formatDuration(s.elapsedMs)
        };
    });
    electron_1.ipcMain.handle('finish:replay', () => {
        (0, logger_1.log)('finish.replay');
        deps?.onReplay();
        closeFinishWindow();
        return { ok: true };
    });
    electron_1.ipcMain.handle('finish:back', () => {
        (0, logger_1.log)('finish.back');
        deps?.onBackToDesktop();
        closeFinishWindow();
        return { ok: true };
    });
}
function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const h = Math.floor(m / 60);
    if (h > 0)
        return `${h} 小时 ${m % 60} 分钟`;
    if (m > 0)
        return `${m} 分 ${total % 60} 秒`;
    return `${total} 秒`;
}
function openFinishWindow(summary, d) {
    deps = d;
    current = summary;
    wire();
    if (win && !win.isDestroyed()) {
        // 已经在显示：刷新数据即可
        win.webContents.send('finish:refresh');
        win.focus();
        return;
    }
    win = new electron_1.BrowserWindow({
        width: 560,
        height: 460,
        minWidth: 480,
        minHeight: 400,
        title: '你的旅程',
        backgroundColor: '#0c0b09',
        autoHideMenuBar: true,
        show: false,
        resizable: true,
        webPreferences: {
            preload: d.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.once('ready-to-show', () => {
        win?.show();
        (0, logger_1.log)('finish.opened', { endKind: summary.endKind, gems: summary.gems });
    });
    win.on('closed', () => {
        win = null;
        (0, logger_1.log)('finish.closed');
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => (0, logger_1.log)('finish.loadFailed', { code, desc }));
    void win.loadFile((0, node_path_1.join)(d.root, 'renderer', 'finish.html'));
}
function closeFinishWindow() {
    if (win && !win.isDestroyed())
        win.close();
}
function finishWindowOpen() {
    return Boolean(win && !win.isDestroyed());
}
