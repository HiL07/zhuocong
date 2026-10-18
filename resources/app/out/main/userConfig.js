"use strict";
/**
 * 用户配置写入层（后端）。
 *
 * 契约：`docs/settings-contract.md`（v1）——**这份文件是唯一约定**，加一个设置项只改这里。
 *
 * 设计要点：
 *   · 稀疏写入：`user-config.json` 只存用户真改过的键，默认值随版本升级自动生效；
 *   · 白名单：只允许写 §4 表里的键（`budget.*` / `privacy.blocklist` 只读）；
 *   · 原子写：`.tmp` → `renameSync` 覆盖，写前留 `.bak`，每次写前留一份 `history/`（最多 10 份）；
 *   · 坏档不炸：JSON 解析失败 → 原名改成 `.corrupt-<ts>.json` → 用默认值继续；
 *   · **一律不抛异常**：这是 UI 路径，抛出去会让桌宠崩。
 *
 * 这个模块**刻意不 import electron**（只用 cfg.root 定位资源），因此可以被
 * `.local/test-userconfig.cjs` 用纯 node 直接 require 验证。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WHITELIST = exports.WHITELIST_KEYS = void 0;
exports.readUserConfig = readUserConfig;
exports.writeUserConfig = writeUserConfig;
exports.resetUserConfig = resetUserConfig;
exports.flattenUserConfig = flattenUserConfig;
exports.buildSettingsModel = buildSettingsModel;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
const logger_1 = require("./logger");
const VOICES = [
    { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（通用）' },
    { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（偏软）' },
    { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女声（东北）' },
    { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女声（陕西）' },
    { value: 'zh-CN-YunxiNeural', label: '云希 · 男声（年轻）' },
    { value: 'zh-CN-YunjianNeural', label: '云健 · 男声（浑厚）' },
    { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播音）' },
    { value: 'zh-CN-YunxiaNeural', label: '云夏 · 男声（少年）' }
];
const RATES = ['-30%', '-20%', '-15%', '-10%', '0%', '+10%', '+20%'].map((v) => ({ value: v, label: v }));
const PITCHES = ['-20Hz', '-10Hz', '0Hz', '+10Hz', '+20Hz'].map((v) => ({ value: v, label: v }));
const SCHEMES = ['deepseek', 'harness', 'chatgpt', 'claude', 'gemini', 'qwen', 'kimi', 'minimax'].map((v) => ({
    value: v,
    label: v
}));
/**
 * 全部字段定义 —— 白名单就是 `form: 'writable'` 的这批（契约 §4）。
 * 顺序 = 界面里的顺序。
 */
const DEFS = [
    // ---- 性格（核心）--------------------------------------------------------
    {
        key: 'chat.personality',
        section: 'personality',
        label: '人格提示词（system prompt）',
        form: 'writable',
        kind: 'string',
        maxLen: 20000,
        rows: 14,
        monospace: true,
        effect: 'now',
        placeholders: ['[桌宠名字]', '[你的称呼]'],
        help: '可以直接粘整张角色卡。占位符 [桌宠名字] / [你的称呼] 保存时原样保留，发送给模型前才替换。',
        fallback: '你是 DeepSeek 桌宠，回答简短、口语化、用中文。'
    },
    {
        key: 'personality.stateInjection',
        section: 'personality',
        label: '在提示词末尾注入当前状态',
        form: 'writable',
        kind: 'boolean',
        effect: 'now',
        help: '开启后追加一个独立段落，如【当前状态：held】；不会插进你的正文中间。',
        fallback: true
    },
    {
        key: 'chat.typewriterCps',
        section: 'personality',
        label: '气泡打字速度（字/秒）',
        form: 'writable',
        kind: 'number',
        min: 5,
        max: 60,
        step: 1,
        effect: 'now',
        advanced: true,
        help: '模型按块返回，必须自己限速才有逐字效果。建议 10~30。',
        fallback: 18
    },
    // ---- 身份 ---------------------------------------------------------------
    {
        key: 'identity.name',
        section: 'identity',
        label: '她的名字',
        form: 'writable',
        kind: 'string',
        maxLen: 24,
        effect: 'now',
        help: '替换人格里的 [桌宠名字]。最多 24 个字符。',
        fallback: '鲸鱼娘'
    },
    {
        key: 'identity.userName',
        section: 'identity',
        label: '她该怎么称呼你',
        form: 'writable',
        kind: 'string',
        maxLen: 24,
        effect: 'now',
        help: '替换人格里的 [你的称呼]。最多 24 个字符。',
        fallback: '你'
    },
    // ---- 语音 ---------------------------------------------------------------
    { key: 'tts.enabled', section: 'voice', label: '语音总开关', form: 'writable', kind: 'boolean', effect: 'now', fallback: true },
    {
        key: 'tts.engine',
        section: 'voice',
        label: '语音引擎',
        form: 'writable',
        kind: 'select',
        effect: 'now',
        options: [
            { value: 'edge', label: 'edge（微软神经语音，免费/联网）' },
            { value: 'gpt-sovits', label: 'GPT-SoVITS（本地克隆，约 5 秒一句）' }
        ],
        help: 'GPT-SoVITS 挂了会自动回退 edge。',
        fallback: 'edge'
    },
    { key: 'tts.voice', section: 'voice', label: '音色（edge）', form: 'writable', kind: 'select', effect: 'now', options: VOICES, fallback: 'zh-CN-XiaoyiNeural' },
    { key: 'tts.rate', section: 'voice', label: '语速', form: 'writable', kind: 'select', effect: 'now', options: RATES, fallback: '-15%' },
    { key: 'tts.pitch', section: 'voice', label: '音调', form: 'writable', kind: 'select', effect: 'now', options: PITCHES, fallback: '-10Hz' },
    {
        key: 'info.gptSovits',
        section: 'voice',
        label: 'GPT-SoVITS 服务',
        form: 'info',
        kind: 'string',
        effect: 'now',
        readonlyReason: '本地服务地址，改它请编辑 config/default.json',
        fallback: '',
        get: (src) => String(src?.tts?.gptSovits?.url ?? '')
    },
    // ---- 形象与渲染 ---------------------------------------------------------
    {
        key: 'pet.renderer',
        section: 'look',
        label: '渲染路线',
        form: 'writable',
        kind: 'select',
        effect: 'reload',
        options: [
            { value: 'rig', label: '实时 rig（物理 + 表情，需 WebGL）' },
            { value: 'frames', label: '预烘焙帧（兼容性最好）' }
        ],
        help: 'rig 出问题就切 frames，两条路都保留。',
        fallback: 'rig'
    },
    { key: 'pet.scheme', section: 'look', label: '配色方案', form: 'writable', kind: 'select', effect: 'now', options: SCHEMES, fallback: 'deepseek' },
    {
        key: 'pet.rigScale',
        section: 'look',
        label: '整体缩放',
        form: 'writable',
        kind: 'number',
        min: 0.7,
        max: 1.5,
        step: 0.05,
        effect: 'now',
        help: '1 = 角色约占窗口高的 80%。',
        fallback: 1
    },
    // ---- 窗口与交互（热键需重启）--------------------------------------------
    { key: 'window.alwaysOnTop', section: 'window', label: '窗口置顶', form: 'writable', kind: 'boolean', effect: 'now', fallback: true },
    {
        key: 'window.ignoreMouseByDefault',
        section: 'window',
        label: '点击穿透（默认）',
        form: 'writable',
        kind: 'boolean',
        effect: 'now',
        help: '开启后鼠标穿过去，她像贴在墙上的贴纸 —— 拖不动也点不着。关掉用托盘或 toggleVisible 热键。',
        fallback: false
    },
    { key: 'hotkeys.toggleScreenPause', section: 'window', label: '截屏暂停', form: 'writable', kind: 'string', effect: 'restart', fallback: 'CommandOrControl+Alt+P' },
    { key: 'hotkeys.toggleVisible', section: 'window', label: '显示 / 隐藏', form: 'writable', kind: 'string', effect: 'restart', fallback: 'CommandOrControl+Alt+O' },
    { key: 'hotkeys.chat', section: 'window', label: '打开聊天窗', form: 'writable', kind: 'string', effect: 'restart', fallback: 'CommandOrControl+Alt+C' },
    { key: 'hotkeys.voice', section: 'window', label: '按住说话', form: 'writable', kind: 'string', effect: 'restart', help: '留空 = 不设全局热键。', fallback: '`' },
    { key: 'hotkeys.quit', section: 'window', label: '退出', form: 'writable', kind: 'string', effect: 'restart', fallback: 'CommandOrControl+Alt+Q' },
    // ---- 模型（高级）--------------------------------------------------------
    // API Key 走"特殊通道"（`secret: true`）：**不写进 user-config.json**，
    // 而是写 `<userData>/.env`（config.ts 里的第三处 .env 查找点），且**永不回显**。
    // 为什么不做成普通键：密钥进 JSON 后容易被备份/分享一并带出去。
    {
        key: 'secrets.apiKey',
        section: 'model',
        label: 'DeepSeek API Key',
        form: 'writable',
        kind: 'string',
        effect: 'now',
        advanced: false,
        fallback: '',
        help: '形如 sk-xxxx。保存后立即生效；只写到本机 userdata/.env，界面不回显（显示为 已配置/未配置）。'
    },
    { key: 'llm.model', section: 'model', label: '模型名', form: 'writable', kind: 'string', effect: 'now', advanced: true, fallback: 'deepseek-flash' },
    {
        key: 'llm.temperature',
        section: 'model',
        label: '温度',
        form: 'writable',
        kind: 'number',
        min: 0,
        max: 2,
        step: 0.1,
        effect: 'now',
        advanced: true,
        fallback: 1
    },
    { key: 'llm.thinking', section: 'model', label: '开启思考', form: 'writable', kind: 'boolean', effect: 'now', advanced: true, fallback: false },
    // ---- 只读（改错会出大事）------------------------------------------------
    {
        key: 'budget.monthlyLimitCNY',
        section: 'data',
        label: '预算上限（元 / 月）',
        form: 'readonly',
        kind: 'number',
        effect: 'now',
        advanced: true,
        readonlyReason: '只读：改错会让所有消息被熔断',
        fallback: 30
    },
    {
        key: 'budget.degradeAtRatio',
        section: 'data',
        label: '降级触发比例',
        form: 'readonly',
        kind: 'number',
        effect: 'now',
        advanced: true,
        readonlyReason: '只读：改错会让所有消息被熔断',
        fallback: 0.7
    },
    {
        key: 'budget.tokensPerCNY',
        section: 'data',
        label: '每元 token 数',
        form: 'readonly',
        kind: 'number',
        effect: 'now',
        advanced: true,
        readonlyReason: '只读：改错会让所有消息被熔断',
        fallback: 400000
    },
    {
        key: 'privacy.blocklist',
        section: 'data',
        label: '敏感窗口黑名单',
        form: 'readonly',
        kind: 'string',
        effect: 'now',
        advanced: true,
        readonlyReason: '只读：安全名单，只能改 config/default.json',
        fallback: '',
        get: (src) => {
            const list = src?.privacy?.blocklist;
            return Array.isArray(list) ? `${list.length} 条` : '0 条';
        }
    },
    // ---- 信息（纯运行时）----------------------------------------------------
    {
        key: 'info.userConfigPath',
        section: 'data',
        label: '用户配置路径',
        form: 'info',
        kind: 'string',
        effect: 'now',
        fallback: '',
        readonlyReason: '运行期信息，不可写'
    },
    {
        key: 'info.logPath',
        section: 'data',
        label: '日志路径',
        form: 'info',
        kind: 'string',
        effect: 'now',
        fallback: '',
        readonlyReason: '运行期信息，不可写'
    },
    {
        key: 'info.cacheBytes',
        section: 'data',
        label: '缓存占用（字节）',
        form: 'info',
        kind: 'number',
        effect: 'now',
        fallback: 0,
        readonlyReason: '运行期统计，不可写'
    },
    {
        key: 'info.apiKeyPresent',
        section: 'data',
        label: 'API Key 已填',
        form: 'info',
        kind: 'boolean',
        effect: 'now',
        fallback: false,
        readonlyReason: '只显示有没有，不返回密钥本身'
    },
    {
        key: 'info.version',
        section: 'about',
        label: '版本',
        form: 'info',
        kind: 'string',
        effect: 'now',
        fallback: '',
        readonlyReason: '只读'
    },
    {
        key: 'info.license',
        section: 'about',
        label: '许可',
        form: 'info',
        kind: 'string',
        effect: 'now',
        fallback: 'AGPL-3.0-or-later',
        readonlyReason: '只读'
    }
];
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));
/** 可写键（白名单，契约 §4） */
const RULES = DEFS.filter((d) => d.form === 'writable');
exports.WHITELIST_KEYS = RULES.map((d) => d.key);
exports.WHITELIST = RULES.map((d) => ({
    key: d.key,
    kind: d.kind,
    min: d.min,
    max: d.max,
    options: d.options?.map((o) => o.value)
}));
const SECTION_META = [
    { id: 'personality', title: '性格', hint: '她说话的方式 —— 一段可以直接粘角色卡的提示词。' },
    { id: 'identity', title: '身份', hint: '她叫什么、她怎么称呼你。' },
    { id: 'voice', title: '语音', hint: '不想要声音就把总开关关掉，只出气泡。' },
    { id: 'look', title: '形象与渲染', hint: '换渲染路线 / 配色 / 大小。' },
    { id: 'window', title: '窗口与交互', hint: '热键改完需要重启才生效。' },
    { id: 'model', title: '模型（高级）', hint: '改错会连不上模型，默认折叠。' },
    { id: 'data', title: '数据', hint: '路径、缓存、预算 —— 这些是只读的。' },
    { id: 'about', title: '关于', hint: '版本与许可。' }
];
// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const CONFIG_FILE = 'user-config.json';
function userConfigPath(userDir) {
    return (0, node_path_1.join)(userDir, CONFIG_FILE);
}
/** yyyyMMdd-HHmmss（本地时间，能按字符串排序就是时间顺序） */
function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return (`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
}
function errText(e) {
    return e instanceof Error ? e.message : String(e);
}
function isScalar(v) {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
function kindOf(v) {
    if (v === null)
        return 'null';
    if (Array.isArray(v))
        return 'array';
    return typeof v;
}
/** 点分路径取值；任何一层不是对象就返回 undefined */
function pathValue(src, key) {
    let cur = src;
    for (const part of key.split('.')) {
        if (cur === null || typeof cur !== 'object')
            return undefined;
        cur = cur[part];
    }
    return cur;
}
/** 点分路径写值；中间层不存在就建对象 */
function setPath(target, key, value) {
    const parts = key.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const next = cur[p];
        if (next === null || typeof next !== 'object' || Array.isArray(next))
            cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}
function clampNum(v, min, max) {
    let x = v;
    if (typeof min === 'number')
        x = Math.max(min, x);
    if (typeof max === 'number')
        x = Math.min(max, x);
    return x;
}
const MODIFIERS = new Set([
    'CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Control', 'Ctrl',
    'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'
]);
const KEY_NAMES = new Set([
    'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute',
    'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen'
]);
/**
 * Electron accelerator 合法性。宽松是故意的：单字符（如 `）、F1~F24、
 * `Ctrl+Alt+C`、`CommandOrControl+Shift+Space` 都放行；空串 = 关掉这个热键。
 */
function validAccelerator(s) {
    if (s === '')
        return true;
    if (s.length > 64)
        return false;
    const parts = s.split('+');
    if (parts.some((p) => p.trim() === '' || p !== p.trim()))
        return false;
    const main = parts[parts.length - 1];
    if (parts.slice(0, -1).some((m) => !MODIFIERS.has(m)))
        return false;
    if (/^[A-Za-z0-9]$/.test(main))
        return true;
    if (KEY_NAMES.has(main))
        return true;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(main))
        return true;
    if (/^[`~!@#$%^&*()\-_=\[\]{}\\|;:'",.<>/?]$/.test(main))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------
/**
 * 读 `user-config.json`。
 *   · 不存在 → `{}`
 *   · 坏档（解析失败 / 顶层不是对象）→ 原名改成 `user-config.corrupt-<ts>.json`，
 *     顺手留一份 `.bak`（怕改坏之前那份还能救），返回 `{}`
 */
function readUserConfig(userDir) {
    const file = userConfigPath(userDir);
    try {
        if (!(0, node_fs_1.existsSync)(file))
            return {};
        const text = (0, node_fs_1.readFileSync)(file, 'utf8');
        if (text.trim() === '')
            return {};
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`顶层不是对象（${kindOf(parsed)}）`);
        }
        return parsed;
    }
    catch (e) {
        const ts = stamp();
        const corrupt = (0, node_path_1.join)(userDir, `user-config.corrupt-${ts}.json`);
        try {
            if ((0, node_fs_1.existsSync)(file))
                (0, node_fs_1.copyFileSync)(file, file + '.bak');
            (0, node_fs_1.renameSync)(file, corrupt);
        }
        catch (e2) {
            (0, logger_1.log)('userconfig.corrupt.moveFailed', { file, err: errText(e2) });
        }
        (0, logger_1.log)('userconfig.corrupt', { file, movedTo: corrupt, err: errText(e) });
        return {};
    }
}
function validateOne(key, raw) {
    const def = DEF_BY_KEY.get(key);
    if (!def)
        return { ok: false, reason: '不在白名单（这个键不允许写入）' };
    if (def.form !== 'writable') {
        return { ok: false, reason: def.readonlyReason ?? '只读字段，不允许写入' };
    }
    switch (def.kind) {
        case 'string': {
            if (typeof raw !== 'string')
                return { ok: false, reason: `需要字符串，收到 ${kindOf(raw)}` };
            const v = raw.replace(/\r\n/g, '\n');
            if (def.maxLen !== undefined && v.length > def.maxLen) {
                return { ok: false, reason: `超过 ${def.maxLen} 字符（当前 ${v.length}）` };
            }
            if (def.key.startsWith('hotkeys.')) {
                if (!validAccelerator(v))
                    return { ok: false, reason: `热键格式不合法（${v}）` };
            }
            return { ok: true, value: v };
        }
        case 'number': {
            let n;
            if (typeof raw === 'number')
                n = raw;
            else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)))
                n = Number(raw);
            else
                return { ok: false, reason: `需要数字，收到 ${kindOf(raw)}` };
            if (!Number.isFinite(n))
                return { ok: false, reason: '需要有限数字' };
            return { ok: true, value: clampNum(n, def.min, def.max) };
        }
        case 'boolean': {
            if (typeof raw === 'boolean')
                return { ok: true, value: raw };
            if (raw === 'true' || raw === 1 || raw === '1')
                return { ok: true, value: true };
            if (raw === 'false' || raw === 0 || raw === '0')
                return { ok: true, value: false };
            return { ok: false, reason: `需要布尔值，收到 ${kindOf(raw)}` };
        }
        case 'select': {
            const allowed = (def.options ?? []).map((o) => o.value);
            if (typeof raw !== 'string')
                return { ok: false, reason: `需要字符串，收到 ${kindOf(raw)}` };
            if (!allowed.includes(raw))
                return { ok: false, reason: `只能取 ${allowed.join(' / ')}` };
            return { ok: true, value: raw };
        }
        default:
            return { ok: false, reason: '未知字段类型' };
    }
}
// ---------------------------------------------------------------------------
// 写（原子写 + .bak + history/）
// ---------------------------------------------------------------------------
function ensureDir(dir) {
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
}
/** 写前把旧文件复制成 `<file>.bak`（只留 1 份） */
function backupOld(file) {
    try {
        if (!(0, node_fs_1.existsSync)(file))
            return;
        (0, node_fs_1.copyFileSync)(file, file + '.bak');
    }
    catch (e) {
        (0, logger_1.log)('userconfig.backup.failed', { file, err: errText(e) });
    }
}
/**
 * 写前把旧内容快照到 `history/user-config-<yyyyMMdd-HHmmss>.json`，
 * 只保留最近 `HISTORY_MAX` 份。同时是"普通保存"和"恢复默认"的后悔药。
 */
const HISTORY_MAX = 10;
function snapshot(file, userDir) {
    try {
        if (!(0, node_fs_1.existsSync)(file))
            return;
        const dir = (0, node_path_1.join)(userDir, 'history');
        ensureDir(dir);
        const ts = stamp();
        // 同一秒内连存几次（拖滑杆）不能互相覆盖；序号补零，保证字典序 = 时间序
        let n = 1;
        let dest = (0, node_path_1.join)(dir, `user-config-${ts}-${String(n).padStart(2, '0')}.json`);
        while ((0, node_fs_1.existsSync)(dest) && n < 999) {
            n += 1;
            dest = (0, node_path_1.join)(dir, `user-config-${ts}-${String(n).padStart(2, '0')}.json`);
        }
        (0, node_fs_1.copyFileSync)(file, dest);
        pruneHistory(dir);
    }
    catch (e) {
        (0, logger_1.log)('userconfig.history.failed', { file, err: errText(e) });
    }
}
function pruneHistory(dir) {
    try {
        const files = (0, node_fs_1.readdirSync)(dir)
            .filter((f) => /^user-config-[\d]{8}-[\d]{6}(-\d+)?\.json$/.test(f))
            .sort(); // 名字里带 yyyyMMdd-HHmmss，字典序 = 时间序
        for (const f of files.slice(0, Math.max(0, files.length - HISTORY_MAX))) {
            try {
                (0, node_fs_1.unlinkSync)((0, node_path_1.join)(dir, f));
            }
            catch {
                /* 删不掉就留着，不阻塞写入 */
            }
        }
    }
    catch {
        /* ignore */
    }
}
/** 原子写：先落 `.tmp`，再 renameSync 覆盖（同盘 rename 是原子的） */
function writeAtomic(file, text) {
    const tmp = file + '.tmp';
    (0, node_fs_1.writeFileSync)(tmp, text, 'utf8');
    (0, node_fs_1.renameSync)(tmp, file);
}
/**
 * 稀疏写入：把 `patch` 里白名单内的键合并进 `user-config.json`。
 *
 * 一律不抛异常；校验失败的键进 `rejected` 且**不写入任何东西**。
 */
function writeUserConfig(userDir, patch) {
    const rejected = [];
    const clean = {};
    const needsRestart = [];
    try {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return { ok: false, rejected: [{ key: '(patch)', reason: 'patch 必须是对象' }], needsRestart: [] };
        }
        for (const [key, raw] of Object.entries(patch)) {
            const r = validateOne(key, raw);
            if (r.ok) {
                clean[key] = r.value;
                const def = DEF_BY_KEY.get(key);
                if (def?.effect === 'restart' && !needsRestart.includes(key))
                    needsRestart.push(key);
            }
            else {
                rejected.push({ key, reason: r.reason });
            }
        }
        if (rejected.length > 0) {
            (0, logger_1.log)('userconfig.rejected', { count: rejected.length, keys: rejected.map((r) => r.key) });
        }
        // 全部被拒 → 不写盘（避免把用户文件改成空壳）
        if (Object.keys(clean).length === 0) {
            return { ok: rejected.length === 0, rejected, needsRestart };
        }
        const file = userConfigPath(userDir);
        ensureDir(userDir);
        // 1) 现有内容（坏档时 readUserConfig 已经把它改名并返回 {}）
        const current = readUserConfig(userDir);
        // 2) 合并：只动白名单键，其余（含 _comment_* 之类）原样保留
        const next = JSON.parse(JSON.stringify(current));
        for (const [key, value] of Object.entries(clean))
            setPath(next, key, value);
        next._meta = {
            ...(typeof current._meta === 'object' && current._meta !== null ? current._meta : {}),
            schema: 1,
            savedAt: new Date().toISOString()
        };
        // 3) 留后悔药：.bak + history/
        backupOld(file);
        snapshot(file, userDir);
        // 4) 原子写
        writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
        (0, logger_1.log)('userconfig.write', {
            file,
            keys: Object.keys(clean),
            rejected: rejected.map((r) => r.key),
            needsRestart
        });
        return { ok: rejected.length === 0, rejected, needsRestart };
    }
    catch (e) {
        (0, logger_1.log)('userconfig.write.failed', { userDir, err: errText(e) });
        return { ok: false, rejected, needsRestart };
    }
}
/** 恢复默认：把现有文件移到 history/ 后删掉主文件（`.bak` 留着当后悔药） */
function resetUserConfig(userDir) {
    const file = userConfigPath(userDir);
    try {
        if (!(0, node_fs_1.existsSync)(file)) {
            (0, logger_1.log)('userconfig.reset', { file, note: 'nothing to reset' });
            return { ok: true };
        }
        snapshot(file, userDir);
        (0, node_fs_1.unlinkSync)(file);
        (0, logger_1.log)('userconfig.reset', { file, movedToHistory: true });
        return { ok: true };
    }
    catch (e) {
        (0, logger_1.log)('userconfig.reset.failed', { file, err: errText(e) });
        return { ok: false };
    }
}
// ---------------------------------------------------------------------------
// 展开（供 loadConfig 做三层合并）
// ---------------------------------------------------------------------------
/** 把对象摊平成 `a.b.c → 叶子值`；数组和非对象都算叶子 */
function flattenLeaves(src, prefix, out) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) {
        if (prefix)
            out.set(prefix, src);
        return;
    }
    for (const [k, v] of Object.entries(src)) {
        flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
}
/** 该路径是不是某个白名单键的前缀（用来发现「对象被写成了标量」这种坏档） */
const WHITELIST_PREFIXES = new Set();
for (const key of exports.WHITELIST_KEYS) {
    const parts = key.split('.');
    for (let i = 1; i < parts.length; i++)
        WHITELIST_PREFIXES.add(parts.slice(0, i).join('.'));
}
/**
 * 把 userConfig 展开成点分键值，供 `loadConfig()` 合并。
 *
 * 只返回**白名单键**的标量值 —— 只读键（budget.* / privacy.blocklist）在合并层就被挡掉，
 * 即使有人手改了文件也不会生效。类型对不上的键记 `userconfig.badType` 后丢弃
 * （`config.ts` 会再按期望类型核一次）。
 */
function flattenUserConfig(userDir) {
    const out = {};
    let raw = {};
    try {
        raw = readUserConfig(userDir);
    }
    catch (e) {
        (0, logger_1.log)('userconfig.read.failed', { userDir, err: errText(e) });
        return out;
    }
    const leaves = new Map();
    flattenLeaves(raw, '', leaves);
    for (const [path, value] of leaves) {
        if (!exports.WHITELIST_KEYS.includes(path)) {
            // 白名单键的祖先被写成了标量（如 "chat": "oops"）→ 记一笔，别静默
            if (WHITELIST_PREFIXES.has(path)) {
                (0, logger_1.log)('userconfig.badType', { key: path, expected: 'object', got: kindOf(value) });
            }
            continue;
        }
        if (!isScalar(value)) {
            (0, logger_1.log)('userconfig.badType', { key: path, expected: 'scalar', got: kindOf(value) });
            continue;
        }
        out[path] = value;
    }
    return out;
}
// ---------------------------------------------------------------------------
// SettingsModel
// ---------------------------------------------------------------------------
function sectionOf(id) {
    const m = SECTION_META.find((s) => s.id === id);
    return { title: m?.title ?? id, hint: m?.hint };
}
function typeOf(def) {
    if (def.form !== 'writable')
        return 'readonly';
    if (def.rows)
        return 'textarea';
    if (def.kind === 'select')
        return 'select';
    if (def.kind === 'boolean')
        return 'switch';
    return def.kind === 'number' ? 'number' : 'text';
}
function resolveValue(def, src) {
    if (def.get)
        return def.get(src);
    const v = pathValue(src, def.key);
    return isScalar(v) ? v : def.fallback;
}
/** 目录递归求和（字节）；读不到就当 0 */
function dirBytes(dir) {
    try {
        if (!(0, node_fs_1.existsSync)(dir))
            return 0;
        const st = (0, node_fs_1.statSync)(dir);
        if (!st.isDirectory())
            return st.size;
        let total = 0;
        for (const name of (0, node_fs_1.readdirSync)(dir))
            total += dirBytes((0, node_path_1.join)(dir, name));
        return total;
    }
    catch {
        return 0;
    }
}
/**
 * 探活 GPT-SoVITS：GET `<url>/openapi.json`，2 秒超时，任何失败都算 false。
 * 用 node:http 而不是 fetch —— 这个模块要能在纯 node 里跑，也不想依赖全局 fetch 类型。
 */
function probe(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(ok);
        };
        try {
            const u = new URL(url);
            const target = new URL('/openapi.json', u.origin);
            const mod = target.protocol === 'https:' ? node_https_1.request : node_http_1.request;
            const req = mod(target, { method: 'GET', timeout: timeoutMs }, (res) => {
                const code = res.statusCode ?? 0;
                finish(code > 0 && code < 500);
                res.resume();
            });
            req.on('timeout', () => {
                finish(false);
                req.destroy();
            });
            req.on('error', () => finish(false));
            req.end();
            timer = setTimeout(() => {
                finish(false);
                try {
                    req.destroy();
                }
                catch {
                    /* ignore */
                }
            }, timeoutMs);
        }
        catch {
            finish(false);
        }
    });
}
/**
 * 生成前端要的 `SettingsModel`：
 *   · `value` = **当前真正生效的值**（cfg 已经过三层合并，含 clamp）
 *   · `default` = `config/default.json` 里的值（"恢复默认"后的样子）
 *   · `readonly` = 只展示、写入会被 rejected
 */
async function buildSettingsModel(userDir, cfg, version) {
    let defaults = {};
    try {
        defaults = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(cfg.root, 'config', 'default.json'), 'utf8'));
    }
    catch {
        defaults = {};
    }
    const file = userConfigPath(userDir);
    const logPath = (0, node_path_1.join)(cfg.root, '.local', 'log.ndjson');
    const cacheBytes = dirBytes((0, node_path_1.join)(cfg.root, '.local', 'tts-cache')) + dirBytes(logPath);
    const sopUrl = cfg.tts?.gptSovits?.url ?? '';
    let reachable = false;
    try {
        reachable = sopUrl ? await probe(sopUrl, 2000) : false;
    }
    catch {
        reachable = false;
    }
    (0, logger_1.log)('userconfig.probe', { url: sopUrl, reachable });
    const info = {
        userConfigPath: file,
        apiKeyPresent: typeof cfg.secrets?.apiKey === 'string' && cfg.secrets.apiKey.trim() !== '',
        logPath,
        cacheBytes,
        gptSovits: { url: sopUrl, reachable }
    };
    // info 字段不在配置树里，直接从运行期算
    const infoValue = (def) => {
        switch (def.key) {
            case 'info.userConfigPath':
                return info.userConfigPath;
            case 'info.logPath':
                return info.logPath;
            case 'info.cacheBytes':
                return info.cacheBytes;
            case 'info.apiKeyPresent':
                return info.apiKeyPresent;
            case 'info.version':
                return version;
            case 'info.gptSovits':
                return info.gptSovits.reachable
                    ? `在线 · ${info.gptSovits.url}`
                    : `未连接 · ${info.gptSovits.url}`;
            default:
                return def.fallback;
        }
    };
    const sections = SECTION_META.map((meta) => {
        const fields = [];
        for (const def of DEFS) {
            if (def.section !== meta.id)
                continue;
            // ⚠️ API Key **永不回显**：返回空串，界面靠 info.apiKeyPresent 显示"已配置/未配置"。
            //    实测踩过：直接把 cfg.secrets.apiKey 塞进 value，等于把密钥明文发给渲染层
            //    （探针里能看到前 20 位）。
            const isSecret = def.key === 'secrets.apiKey';
            const value = isSecret
                ? ''
                : def.form === 'info'
                    ? infoValue(def)
                    : resolveValue(def, cfg);
            const dflt = def.form === 'info' ? def.fallback : resolveValue(def, defaults) ?? def.fallback;
            const spec = {
                key: def.key,
                type: typeOf(def),
                label: def.label,
                value,
                default: dflt,
                effect: def.effect
            };
            if (def.help)
                spec.help = def.help;
            // API Key 的**状态提示**：输入框永远不回显（防明文进渲染层），
            // 但必须让人看得出"已经配过了"，否则用户会反复重填、以为没保存
            //（2026-10-18 实测：用户连填三次，其实每次都写进了 userData/.env）。
            if (isSecret) {
                const real = typeof cfg.secrets?.apiKey === 'string' ? cfg.secrets.apiKey.trim() : '';
                const tail = real.length >= 4 ? real.slice(-4) : '';
                spec.help = real
                    ? `✅ 已配置（末四位 ${tail}）· 想换就重新粘贴，留空表示保持不变`
                    : '⚠️ 未配置：粘贴 sk-xxxx 后自动保存到本机 userdata/.env（不进 JSON、不回显）';
            }
            if (def.options)
                spec.options = def.options;
            if (def.min !== undefined)
                spec.min = def.min;
            if (def.max !== undefined)
                spec.max = def.max;
            if (def.step !== undefined)
                spec.step = def.step;
            if (def.rows !== undefined)
                spec.rows = def.rows;
            if (def.monospace)
                spec.monospace = true;
            if (def.advanced)
                spec.advanced = true;
            if (def.placeholders)
                spec.placeholders = def.placeholders;
            if (def.readonlyReason && def.form !== 'writable')
                spec.readonlyReason = def.readonlyReason;
            fields.push(spec);
        }
        const { title, hint } = sectionOf(meta.id);
        const s = { id: meta.id, title, fields };
        if (hint)
            s.hint = hint;
        return s;
    });
    return { version, sections, info };
}
