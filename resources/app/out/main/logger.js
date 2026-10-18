"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
/**
 * 统一日志：NDJSON 追加写入 .local/log.ndjson。
 * P1 的 decision_log 会复用同一通道。
 */
function log(event, data = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    // eslint-disable-next-line no-console
    console.log(`[pet] ${line}`);
    try {
        const dir = (0, node_path_1.join)((0, config_1.projectRoot)(), '.local');
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        (0, node_fs_1.appendFileSync)((0, node_path_1.join)(dir, 'log.ndjson'), line + '\n', 'utf8');
    }
    catch {
        /* 日志失败不影响主流程 */
    }
}
