"use strict";
/**
 * 剧本注册表 —— **加一个章节只需要动这一个文件**（加一行 import + 一行数组项）。
 *
 * 为什么用静态 import 而不是"扫描目录动态加载"：
 *   ① 没有打包器，动态加载要自己拼 `out/` 路径，容易在打包/迁移时碎；
 *   ② 静态 import 能被 `tsc` 检查，写错在编译期就报；
 *   ③ 章节数量个位数，没有懒加载的必要。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORIES = void 0;
exports.findStory = findStory;
exports.listStories = listStories;
const demo_node1_1 = require("./stories/demo-node1");
exports.STORIES = [
    demo_node1_1.demoNode1
    // 以后加：import { node2Seaside } from './stories/node2-seaside'  →  加进来即可
];
function findStory(id) {
    return exports.STORIES.find((s) => s.meta.id === id);
}
/** 给 UI 用的清单（不含实现） */
function listStories() {
    return exports.STORIES.map((s) => ({ ...s.meta }));
}
