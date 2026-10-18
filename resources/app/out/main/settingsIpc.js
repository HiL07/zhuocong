"use strict";
/**
 * 设置相关的 IPC 接线（从 index.ts 里拆出来，避免它继续膨胀）。
 *
 * 分三块：
 *   ① 读配置模型 → 给设置窗渲染表单（`settings:get`）
 *   ② 写配置 → 白名单校验 + 稀疏落盘 + 立即热生效（`settings:save`）
 *   ③ 试说一句 / 试听 / 清缓存 / 开目录 / 重启（都是"验证性"动作，让用户敢改）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wireSettingsIpc = wireSettingsIpc;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
const prompt_1 = require("./prompt");
const settingsWindow_1 = require("./settingsWindow");
/**
 * 把 API Key 写进 `<userData>/.env`（保留文件里其它键）。
 *
 * 为什么是 .env 而不是 JSON：`config.ts` 的 .env 查找顺序里第三处就是 userData，
 * 而且 .env 天然是"本机机密"，不会被随手分享设置时带出去。
 */
function writeApiKeyEnv(userDir, apiKey) {
    const envPath = (0, node_path_1.join)(userDir, '.env');
    const kept = [];
    if ((0, node_fs_1.existsSync)(envPath)) {
        for (const line of (0, node_fs_1.readFileSync)(envPath, 'utf8').split(/\r?\n/)) {
            if (!line.trim())
                continue;
            if (/^\s*DEEPSEEK_API_KEY\s*=/i.test(line))
                continue; // 旧值丢掉，下面重写
            kept.push(line);
        }
    }
    if (apiKey)
        kept.push(`DEEPSEEK_API_KEY=${apiKey}`);
    (0, node_fs_1.writeFileSync)(envPath, kept.join('\n') + '\n', 'utf8');
}
const userConfig_1 = require("./userConfig");
function wireSettingsIpc(deps) {
    const open = () => (0, settingsWindow_1.openSettingsWindow)({ root: deps.root, preload: deps.preload });
    electron_1.ipcMain.handle('settings:open', () => {
        open();
        return { ok: true };
    });
    electron_1.ipcMain.handle('settings:get', async () => {
        const cfg = deps.reloadConfig();
        return (0, userConfig_1.buildSettingsModel)(electron_1.app.getPath('userData'), cfg, electron_1.app.getVersion());
    });
    electron_1.ipcMain.handle('settings:save', (_e, patchIn) => {
        const userDir = electron_1.app.getPath('userData');
        const patch = { ...(patchIn ?? {}) };
        // ---- API Key 特殊通道 ----
        // 密钥**不进 user-config.json**：备份/分享配置时很容易把它一起带出去。
        // 改写到 `<userData>/.env`（config.ts 会读这里），且永不回显。
        if (typeof patch['secrets.apiKey'] === 'string') {
            const key = String(patch['secrets.apiKey']).trim();
            delete patch['secrets.apiKey'];
            try {
                writeApiKeyEnv(userDir, key);
                (0, logger_1.log)('settings.apiKey', { set: key.length > 0, length: key.length });
            }
            catch (e) {
                (0, logger_1.log)('settings.apiKeyFailed', { error: String(e).slice(0, 160) });
            }
            // 让后续 reloadConfig() 读到新 key
            process.env.DEEPSEEK_API_KEY = key;
        }
        const res = (0, userConfig_1.writeUserConfig)(userDir, patch);
        (0, logger_1.log)('settings.save', {
            keys: Object.keys(patch).length,
            ok: res.ok,
            rejected: res.rejected?.map((r) => r.key) ?? [],
            needsRestart: res.needsRestart ?? []
        });
        // 让所有窗口知道配置变了（设置窗自己也会收到，用于多窗回填）
        for (const w of require('electron').BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed())
                w.webContents.send('settings:changed', { patch, result: res });
        }
        return res;
    });
    electron_1.ipcMain.handle('settings:reset', () => {
        const res = (0, userConfig_1.resetUserConfig)(electron_1.app.getPath('userData'));
        (0, logger_1.log)('settings.reset', res);
        return res;
    });
    /** 试说一句：把"实际会发出去的 system prompt"也返回，界面可以展开给用户看 */
    electron_1.ipcMain.handle('settings:previewPersonality', async (_e, args) => {
        const cfg = deps.reloadConfig();
        const personality = typeof args?.personality === 'string' ? args.personality : cfg.chat.personality;
        const promptSent = (0, prompt_1.buildSystemPrompt)({
            personality,
            name: cfg.identity.name,
            userName: cfg.identity.userName,
            stateInjection: cfg.personality.stateInjection,
            state: deps.currentState()
        });
        const sample = (args?.sample ?? '').trim() || '你好呀';
        try {
            const { reply, ms } = await deps.askOnce(promptSent, sample, cfg);
            return { ok: true, reply, promptSent, ms };
        }
        catch (e) {
            return { ok: false, promptSent, error: String(e).slice(0, 300) };
        }
    });
    electron_1.ipcMain.handle('settings:previewVoice', async (_e, args) => {
        const text = (args?.text ?? '').trim() || '你好呀，我是小鲸鱼。';
        try {
            return await deps.synthVoice(text);
        }
        catch (e) {
            return { ok: false, error: String(e).slice(0, 300) };
        }
    });
    electron_1.ipcMain.handle('settings:clearCache', () => deps.clearCache());
    electron_1.ipcMain.handle('settings:openLogDir', async () => {
        const dir = (0, node_path_1.join)(deps.root, '.local');
        await electron_1.shell.openPath(dir);
        return { ok: true, dir };
    });
    electron_1.ipcMain.handle('settings:restart', () => {
        (0, logger_1.log)('settings.restart');
        electron_1.app.relaunch();
        electron_1.app.exit(0);
        return { ok: true };
    });
    return { open };
}
