/**
 * 小游戏窗口的 preload —— 只做一件事：把 `window.petEvent` 暴露给游戏页面。
 *
 * 为什么必须走 preload（而不是在主进程里 executeJavaScript 注入）：
 *   游戏页面在**隔离世界**（contextIsolation）里，主进程用 executeJavaScript 只能改
 *   主世界（页面自己的 `window`），而游戏代码调用的 `window.petEvent` 必须在**主世界**里存在。
 *   contextBridge 正好干这件事：把隔离世界里的函数"挂"到主世界。
 *
 * 为什么方向是"页面 → 主进程"：
 *   游戏里已经有 `window.__STORY__` 状态，但 preload 在隔离世界读不到它（这是设计如此）。
 *   所以不让宿主去轮询状态，而是让**游戏主动推事件**（`emit()`，见 docs/game-hooks.md）。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petEvent', (kind, data) => {
  try {
    ipcRenderer.send('game:event', {
      kind: typeof kind === 'string' ? kind.slice(0, 40) : '',
      data: data && typeof data === 'object' ? data : {}
    })
  } catch {
    /* 窗口正在关闭时可能失败，忽略 */
  }
})

// 让游戏能问"宿主在不在"（可选，纯锦上添花）
contextBridge.exposeInMainWorld('petHost', {
  version: process.env.PET_VERSION || 'dev'
})
