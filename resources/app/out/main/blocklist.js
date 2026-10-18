"use strict";
/**
 * 敏感窗口黑名单判定 —— **纯函数，不许 import electron**。
 *
 * 为什么单独一个文件：它要能在命令行里被验证（`tools/verify-screenlook.mjs`），
 * 而 `config.ts` 顶部 `import { app, nativeImage } from 'electron'`，
 * 一旦被 node 直接 require 就会炸（electron 模块在纯 Node 里只是个路径字符串）。
 * 所以把这条判据抽出来，config.ts 再 re-export 保持旧调用点不变。
 *
 * 用法（屏幕感知的**前置**闸门，抓屏之前就判）：
 *   isBlocked(前台窗口标题, cfg.privacy.blocklist) === true  ⇒ 不抓、不看
 * 注意：**前置**很重要 —— 事后过滤意味着敏感画面已经进了内存/日志。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBlocked = isBlocked;
exports.blocklistSelfTest = blocklistSelfTest;
/** 大小写不敏感的子串匹配。空标题 = 判不了 = 不拦（由调用方决定要不要更保守）。 */
function isBlocked(title, blocklist) {
    if (!title)
        return false;
    const t = title.toLowerCase();
    return blocklist.some((k) => k.trim() !== '' && t.includes(k.trim().toLowerCase()));
}
/** 自检用的样例（启动日志里打过一次，用来确认黑名单真的生效） */
function blocklistSelfTest(blocklist) {
    return {
        '1Password 8': isBlocked('1Password 8', blocklist),
        'Visual Studio Code': isBlocked('Visual Studio Code', blocklist)
    };
}
