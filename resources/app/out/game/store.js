"use strict";
/**
 * 存档：点号分层的 JSON（`bag', 'yuanShi.count`）。
 *
 * 为什么自己写而不是上库：需求很小（几百字节的键值），
 * 而且**必须能离线验证**（`tools/verify-story.mjs` 里用内存实现替换它）。
 * 落盘位置：`<项目>/.local/games/<engineId>.json`
 *   —— `.local` 已在 `make_share_bundle.py` 的黑名单里，存档不会被分享出去。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryStateStore = exports.FileStateStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function deepGet(obj, path) {
    return path.split('.').reduce((acc, k) => {
        if (acc && typeof acc === 'object')
            return acc[k];
        return undefined;
    }, obj);
}
function deepSet(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        const next = cur[k];
        if (!next || typeof next !== 'object')
            cur[k] = {};
        cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
}
/** 文件版（生产用） */
class FileStateStore {
    data = {};
    file;
    constructor(engineId, root) {
        this.file = (0, node_path_1.join)(root, '.local', 'games', `${engineId}.json`);
        try {
            if ((0, node_fs_1.existsSync)(this.file)) {
                this.data = JSON.parse((0, node_fs_1.readFileSync)(this.file, 'utf8'));
            }
        }
        catch {
            // 存档坏了就当新开局，别把游戏带崩
            this.data = {};
        }
    }
    get(key, dflt) {
        const v = deepGet(this.data, key);
        return (v === undefined ? dflt : v);
    }
    set(key, value) {
        deepSet(this.data, key, value);
    }
    save() {
        try {
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(this.file), { recursive: true });
            (0, node_fs_1.writeFileSync)(this.file, JSON.stringify(this.data, null, 2), 'utf8');
        }
        catch {
            // 写盘失败不该打断游戏
        }
    }
    snapshot() {
        return JSON.parse(JSON.stringify(this.data));
    }
    reset() {
        this.data = {};
        this.save();
    }
}
exports.FileStateStore = FileStateStore;
/** 内存版（命令行验证用） */
class MemoryStateStore {
    data = {};
    get(key, dflt) {
        const v = deepGet(this.data, key);
        return (v === undefined ? dflt : v);
    }
    set(key, value) {
        deepSet(this.data, key, value);
    }
    save() {
        /* 内存版不落盘 */
    }
    snapshot() {
        return JSON.parse(JSON.stringify(this.data));
    }
    reset() {
        this.data = {};
    }
}
exports.MemoryStateStore = MemoryStateStore;
