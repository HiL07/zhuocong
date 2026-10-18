/**
 * 通关结算页的逻辑。
 *
 * ⚠️ 必须放在**外部文件**里，不能写成 HTML 内联 `<script>`：
 *    页面 CSP 是 `script-src 'self'`，内联脚本会被直接拦掉 ——
 *    表现是"窗口开了但一片空白"，控制台报 CSP 违规（2026-10-18 实测踩到）。
 */

'use strict'

const $ = (id) => document.getElementById(id)

/** 兜底数据：没有后端（浏览器直开 file://）时也能看到完整界面 */
const MOCK = {
  endKind: 'good',
  kicker: 'GOOD ENDING',
  title: '回到现实',
  node: 5,
  gems: 5,
  dimGems: 0,
  affinity: '依赖',
  hurt: 2,
  rescued: true,
  dreamLoops: 0,
  elapsedMs: 47 * 60 * 1000,
  playerName: '',
  companionName: '',
  theme: '要善待身边的人。',
  elapsedText: '47 分 0 秒'
}

function render(d) {
  const data = d || MOCK
  $('kicker').textContent = data.kicker || 'ENDING'
  $('title').textContent = data.title || '旅程结束'
  const who = [data.playerName, data.companionName].filter(Boolean).join(' & ')
  $('sub').textContent = who ? `${who} · 第 ${data.node} 章` : `第 ${data.node} 章 · 走到这里`

  // 原石：点亮 = 拿到；暗 = 拿到了但暗淡；虚线 = 没拿到
  $('gemsText').textContent = String(data.gems)
  const box = $('gems')
  box.textContent = ''
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('div')
    el.className = 'gem' + (i < data.gems ? '' : i < data.gems + data.dimGems ? ' dim' : ' off')
    el.title = i < data.gems ? '已获得' : i < data.gems + data.dimGems ? '已暗淡' : '未获得'
    box.appendChild(el)
  }

  $('affinity').textContent = data.affinity || '生疏'
  $('elapsed').textContent = data.elapsedText || '—'

  // 把 flags 翻译成人话标签
  const tags = []
  if (data.rescued) tags.push({ t: '救下了同伴', good: true })
  if (data.hurt === 0) tags.push({ t: '一次没受伤', good: true })
  else if (data.hurt >= 5) tags.push({ t: `受伤 ${data.hurt} 次`, bad: true })
  if (data.dimGems > 0) tags.push({ t: `${data.dimGems} 颗原石暗淡`, bad: true })
  if (data.dreamLoops > 0) tags.push({ t: `陷入梦境 ${data.dreamLoops} 次` })
  if (data.gems === 5) tags.push({ t: '五颗原石', good: true })
  const tr = $('traits')
  tr.textContent = ''
  for (const x of tags) {
    const el = document.createElement('span')
    el.className = 'tag' + (x.good ? ' good' : x.bad ? ' bad' : '')
    el.textContent = x.t
    tr.appendChild(el)
  }

  // 主题句：原样出现一次（金发旅人那句）
  const q = $('quote')
  const first = q.firstChild
  if (first && first.nodeType === 3) first.textContent = '「' + (data.theme || '') + '」'
  else q.textContent = '「' + (data.theme || '') + '」'
  $('quoteFrom').textContent = '—— 金发旅人'
}

async function load() {
  try {
    const d = window.pet && window.pet.finishData ? await window.pet.finishData() : null
    render(d)
    if (!d) $('err').textContent = '（演示数据）'
  } catch (e) {
    $('err').textContent = '读取结算数据失败'
    render(MOCK)
  }
}

$('replay').addEventListener('click', async () => {
  $('replay').disabled = true
  try {
    if (window.pet && window.pet.finishReplay) await window.pet.finishReplay()
    else window.close()
  } catch {
    $('err').textContent = '重开失败'
    $('replay').disabled = false
  }
})

$('back').addEventListener('click', async () => {
  try {
    if (window.pet && window.pet.finishClose) await window.pet.finishClose()
    else window.close()
  } catch {
    window.close()
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('back').click()
  if (e.key === 'Enter') $('replay').click()
})

if (window.pet && window.pet.onFinishRefresh) window.pet.onFinishRefresh(load)
load()
