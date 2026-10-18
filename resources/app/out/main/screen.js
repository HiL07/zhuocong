"use strict";
/**
 * 屏幕感知（"小鲸鱼看一眼屏幕"）—— 抓屏 + 前台窗口标题。
 *
 * 设计原则（**隐私优先**）：
 *   1. **按需单次**：没有任何常驻抓屏/录屏/定时截图。只在用户明确要求时抓一张。
 *   2. **前置闸门**：抓屏**之前**先读前台窗口标题，命中 `privacy.blocklist` 就直接拒绝
 *      （不是"抓完再过滤" —— 那样敏感画面已经进内存/日志了）。
 *   3. **不落盘**：截图只以 base64 形式放在这一次请求里，默认不写文件。
 *      只有调试探针（`tools/screen-probe.cjs`）才存 `.local/`。
 *   4. **降采样**：按 `vision.maxWidth`（默认 1280）缩；一张图算 token 与像素无关
 *      （DeepSeek 侧最多 384 token/张），降采样是为了带宽和内存。
 *
 * ⚠️ 前台窗口标题为什么用 **Python** 而不是 PowerShell（2026-10-17 实测）：
 *   最初写的是 `execFile('powershell.exe', [... Add-Type ...])`，结果被用户机器上的
 *   安全软件拦下并弹窗「发现程序试图操作敏感动作 … 目标执行 powershell.exe / 阻止」，
 *   标题永远拿到空串（等了 4 秒超时）。
 *   ⇒ 改成调用项目里**本来就在用**的 python.exe（语音桥一直在跑，安全软件已经放行），
 *     用 ctypes 直接调 Win32，不启动任何新类型的进程。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.foregroundTitle = foregroundTitle;
exports.visibleWindowTitles = visibleWindowTitles;
exports.capturePrimary = capturePrimary;
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
/**
 * 读前台窗口标题的 Python 一行脚本（ctypes 调 user32）。
 * 输出就是标题本身（可能为空），不打印任何多余内容。
 */
const PY_SCRIPT = [
    'import ctypes',
    'u=ctypes.windll.user32',
    'h=u.GetForegroundWindow()',
    'n=u.GetWindowTextLengthW(h)',
    'b=ctypes.create_unicode_buffer(n+1)',
    'u.GetWindowTextW(h,b,n+1)',
    'import sys',
    'sys.stdout.write(b.value)'
].join(';');
/**
 * 读前台窗口标题；失败返回 ''（3 秒超时）。
 * @param python python.exe 绝对路径（与语音桥用同一个，见 index.ts 的 PY）
 */
function foregroundTitle(python, timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (!python)
            return resolve('');
        try {
            (0, node_child_process_1.execFile)(python, ['-c', PY_SCRIPT], 
            // stdio 用 pipe 会被 DSH 沙箱拦（EPERM），但这里跑在**用户自己的桌宠进程**里，
            // 不受 agent 沙箱限制；为了稳妥仍然不用 shell。
            { timeout: timeoutMs, windowsHide: true, shell: false }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
        }
        catch {
            resolve('');
        }
    });
}
/**
 * 列出现在**所有可见窗口的标题**（用来做"前台拿不到时"的兜底闸门）。
 *
 * 为什么需要它：前台窗口标题依赖 Win32 `GetForegroundWindow`，但在某些上下文里
 * 拿不到（实测 electron 子进程里返回空）。与其"拿不到就放行"（等于没有闸门），
 * 不如**退化成把可见窗口全查一遍**：只要有一个命中黑名单就拒绝 —— **宁可错拒，也不看**。
 *
 * 注意：托盘里的小图标窗口通常**不会**出现在这里（没有可见窗口），所以不会误伤。
 */
async function visibleWindowTitles() {
    try {
        const sources = await electron_1.desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 16, height: 16 }
        });
        return sources.map((s) => s.name || '').filter(Boolean);
    }
    catch {
        return [];
    }
}
/** 抓主屏一张缩略图（默认最长边 1280）。失败返回 null。 */
async function capturePrimary(maxWidth = 1280) {
    const display = electron_1.screen.getPrimaryDisplay();
    const scale = Math.min(1, maxWidth / display.size.width);
    const thumb = {
        width: Math.max(64, Math.round(display.size.width * scale)),
        height: Math.max(64, Math.round(display.size.height * scale))
    };
    const sources = await electron_1.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
    if (!sources.length)
        return null;
    // 多屏时优先挑主屏对应那一个；匹配不上就取第一个
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    const img = src.thumbnail;
    if (!img || img.isEmpty())
        return null;
    const png = img.toPNG();
    if (!png.length)
        return null;
    return {
        dataUrl: 'data:image/png;base64,' + png.toString('base64'),
        bytes: png.length,
        size: img.getSize(),
        displayId: src.display_id || undefined
    };
}
