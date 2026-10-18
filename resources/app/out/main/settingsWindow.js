"use strict";
/**
 * 设置窗口（独立窗，760×680）。
 *
 * 为什么单独一个窗口而不是 Tab 塞进聊天窗：
 *   · 聊天窗是"随手说话"的轻界面，设置是"认真改配置"的重界面，混一起两边都别扭；
 *   · 设置窗要长期开着对照修改（改一点、试说一句、再改），独立窗可以并排放。
 *
 * 配置的读写全在 `userConfig.ts`（稀疏写入 + 白名单 + 原子写），这里只负责开窗与 IPC 接线。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.openSettingsWindow = openSettingsWindow;
exports.closeSettingsWindow = closeSettingsWindow;
exports.settingsWindowOpen = settingsWindowOpen;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
let win = null;
function openSettingsWindow(deps) {
    if (win && !win.isDestroyed()) {
        if (win.isMinimized())
            win.restore();
        win.focus();
        (0, logger_1.log)('settings.focus');
        return;
    }
    win = new electron_1.BrowserWindow({
        width: 760,
        height: 680,
        minWidth: 680,
        minHeight: 560,
        title: '设置 · 桌宠',
        backgroundColor: '#faf7f2', // 与 chat.css 的 --bg 一致，避免白闪
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: deps.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false
        }
    });
    win.once('ready-to-show', () => {
        win?.show();
        (0, logger_1.log)('settings.opened', { size: { w: 760, h: 680 } });
    });
    win.on('closed', () => {
        win = null;
        (0, logger_1.log)('settings.closed');
    });
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2)
            (0, logger_1.log)('settings.console', { level, message: String(message).slice(0, 300) });
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
        (0, logger_1.log)('settings.loadFailed', { code, desc });
    });
    void win.loadFile((0, node_path_1.join)(deps.root, 'renderer', 'settings.html'));
}
function closeSettingsWindow() {
    if (win && !win.isDestroyed())
        win.close();
}
function settingsWindowOpen() {
    return Boolean(win && !win.isDestroyed());
}
