"use strict";
/**
 * LLM Provider 抽象层。
 *
 * 为什么单独抽一层：
 *   换模型（deepseek → 别的）不该动 chat 逻辑；而且这一层要能在
 *   **命令行里独立验证**（`tools/verify-llm.mjs`），
 *   所以这里的代码**不许 import electron**，只依赖标准 Node。
 *
 * 为什么要回调而不是 AsyncIterable：
 *   实际用途是「主进程边收边广播给渲染层」，
 *   回调写起来最直接，也不需要处理背压。
 *   `onFirstToken` 单独给一个钩子，因为**首字延迟是 Day 1 的硬验收指标**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
