"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatWindow = createChatWindow;
exports.ensureChatWindow = ensureChatWindow;
/**
 * 聊天窗：与桌宠窗分离的第二个 BrowserWindow。
 *
 * 为什么单独开一个窗，而不是在桌宠窗里塞输入框（D6 决策）：
 *   桌宠窗是 240×262 的透明置顶小窗。在里面打字要么把窗口撑大破坏观感，
 *   要么抢走键盘焦点、挡住用户正在用的程序。
 *   单独开一个普通窗口，两边互不干扰。
 *
 * 与桌宠窗的关键差异：
 *   · frame: true        有标题栏，能拖动、能最小化
 *   · resizable: true    可以拉大
 *   · alwaysOnTop: false **不置顶** —— 用户切走时它该让位
 *   · skipTaskbar: false 任务栏里能找得到（和桌宠窗相反）
 *   · transparent: false 不透明，普通窗口
 */
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
/** 默认尺寸。聊天窗给足高度，消息列表才好看。 */
const W = 400;
const H = 540;
/** 与桌宠窗之间的间距 */
const GAP = 12;
/**
 * 把聊天窗摆在桌宠窗**旁边**。
 *
 * 优先放右侧；右边放不下就放左侧；两边都放不下就贴到屏幕右边缘。
 * 垂直方向与桌宠窗顶部对齐，但不越出工作区。
 */
function placeNear(petBounds, w, h) {
    const { workArea } = electron_1.screen.getPrimaryDisplay();
    if (!petBounds) {
        return {
            x: Math.round(workArea.x + workArea.width - w - 40),
            y: Math.round(workArea.y + workArea.height - h - 60)
        };
    }
    const rightX = petBounds.x + petBounds.width + GAP;
    const leftX = petBounds.x - w - GAP;
    let x;
    if (rightX + w <= workArea.x + workArea.width)
        x = rightX;
    else if (leftX >= workArea.x)
        x = leftX;
    else
        x = workArea.x + workArea.width - w - 8;
    let y = petBounds.y + petBounds.height - h; // 底边对齐，视觉上"坐在桌宠旁边"
    y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - h - 8));
    return { x: Math.round(x), y: Math.round(y) };
}
function createChatWindow(deps, petBounds) {
    const { x, y } = placeNear(petBounds, W, H);
    const win = new electron_1.BrowserWindow({
        width: W,
        height: H,
        x,
        y,
        minWidth: 300,
        minHeight: 320,
        frame: true,
        resizable: true,
        maximizable: true,
        minimizable: true,
        fullscreenable: false,
        // 刻意不置顶：用户切到别的程序时，聊天窗应该老老实实让位
        alwaysOnTop: false,
        skipTaskbar: false,
        show: false,
        title: 'DSH 桌宠 · 聊天',
        backgroundColor: '#faf7f2',
        webPreferences: {
            preload: deps.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => {
        win.show();
        win.focus();
    });
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl)
        void win.loadURL(devUrl.replace(/\/$/, '') + '/chat.html');
    else
        void win.loadFile((0, node_path_1.join)(__dirname, '..', '..', 'renderer', 'chat.html'));
    (0, logger_1.log)('chatWindow.created', { bounds: win.getBounds(), nearPet: petBounds ?? null });
    return win;
}
/** 复用已存在的聊天窗，没有才新建。返回窗口与「是否新建」。 */
function ensureChatWindow(existing, deps, petBounds) {
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized())
            existing.restore();
        existing.show();
        existing.focus();
        return { win: existing, created: false };
    }
    return { win: createChatWindow(deps, petBounds), created: true };
}
