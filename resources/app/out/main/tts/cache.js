"use strict";
/**
 * TTS 音频缓存：同一句 + 同参数 → 直接用上次的文件。
 *
 * 为什么必须有：桌宠的日常台词重复率很高（"好呀"、"嗯……"、打招呼、口头禅），
 * 而 edge-tts 每次要 1~1.5 秒、GPT-SoVITS 每次要 2~5 秒。
 * 缓存之后重复句是 **0 毫秒**，这是"听起来不卡"的关键。
 *
 * 设计：
 *   · 键 = sha1(engine|voice|rate|pitch|speed|text)
 *   · 文件名 = <key>.<ext>，落在 `<root>/.local/tts-cache/`
 *   · 满了按 **mtime 最旧** 淘汰（简单 LRU 近似），上限由 config.tts.cacheMB 控制
 *   · `.local` 已在分享包黑名单里 ⇒ 缓存不会被打包
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioCache = void 0;
exports.cacheKey = cacheKey;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function cacheKey(parts) {
    const h = (0, node_crypto_1.createHash)('sha1');
    for (const p of parts)
        h.update(String(p ?? ''), 'utf8');
    return h.digest('hex');
}
class AudioCache {
    dir;
    maxBytes;
    constructor(root, maxMB) {
        this.dir = (0, node_path_1.join)(root, '.local', 'tts-cache');
        this.maxBytes = Math.max(1, maxMB) * 1024 * 1024;
        try {
            (0, node_fs_1.mkdirSync)(this.dir, { recursive: true });
        }
        catch {
            /* 建不了目录就当没有缓存，不影响说话 */
        }
    }
    get(key, ext) {
        const p = (0, node_path_1.join)(this.dir, `${key}.${ext}`);
        try {
            if (!(0, node_fs_1.existsSync)(p))
                return null;
            const buf = (0, node_fs_1.readFileSync)(p);
            // 摸一下 mtime，让"最近用过"的更像新文件（近似 LRU）
            try {
                const now = new Date();
                require('node:fs').utimesSync(p, now, now);
            }
            catch { /* ignore */ }
            return buf;
        }
        catch {
            return null;
        }
    }
    put(key, ext, data) {
        try {
            (0, node_fs_1.writeFileSync)((0, node_path_1.join)(this.dir, `${key}.${ext}`), data);
            this.evict();
        }
        catch {
            /* 写失败就下次重新合成，不抛 */
        }
    }
    /** 超过上限就删最旧的，直到压到 80% 以下（避免每次都删） */
    evict() {
        try {
            const files = (0, node_fs_1.readdirSync)(this.dir)
                .map((f) => {
                const p = (0, node_path_1.join)(this.dir, f);
                const st = (0, node_fs_1.statSync)(p);
                return { p, size: st.size, mtime: st.mtimeMs };
            })
                .sort((a, b) => a.mtime - b.mtime);
            let total = files.reduce((s, f) => s + f.size, 0);
            if (total <= this.maxBytes)
                return;
            const target = this.maxBytes * 0.8;
            for (const f of files) {
                if (total <= target)
                    break;
                try {
                    (0, node_fs_1.unlinkSync)(f.p);
                    total -= f.size;
                }
                catch { /* ignore */ }
            }
        }
        catch {
            /* ignore */
        }
    }
    sizeInfo() {
        try {
            const files = (0, node_fs_1.readdirSync)(this.dir).map((f) => (0, node_path_1.join)(this.dir, f));
            let bytes = 0;
            for (const p of files) {
                try {
                    bytes += (0, node_fs_1.statSync)(p).size;
                }
                catch { /* ignore */ }
            }
            return { files: files.length, bytes };
        }
        catch {
            return { files: 0, bytes: 0 };
        }
    }
}
exports.AudioCache = AudioCache;
