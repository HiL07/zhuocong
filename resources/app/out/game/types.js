"use strict";
/**
 * 互动叙事小游戏（超文本 + 跑团）—— **契约层**。
 *
 * 这一层只放类型，**不许 import electron / node / dom**：
 * 剧本引擎要能在命令行里被单独验证（`tools/verify-story.mjs`），
 * 也要能被将来任意一种实现替换（本地剧本 / LLM 生成 / 远程服务）。
 *
 * 设计原则：
 *   1. **引擎是纯函数式的一问一答**：宿主给输入，引擎返回一个「节拍」（Beat）。
 *      引擎不直接碰窗口、不直接发 IPC、不自己存盘 —— 全部通过 `StoryContext` 里的能力。
 *   2. **节拍驱动表现**：一个 Beat 里同时带叙事文本、表情、骰面、选项、状态增量，
 *      宿主负责把它翻译成"气泡 + 神态 + UI 面板"。
 *   3. **存档是宿主的责任**：引擎只通过 `ctx.state` 读写，宿主决定存哪。
 *
 * 剧本作者只要实现 `StoryEngine`，就能被挂进来 —— 见 `stories/demo-node1.ts`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
