/**
 * 桌宠 rig 页的驱动脚本（renderer/rig.html 的 module）。
 *
 * ⚠️ 为什么单独一个文件而不是内联 <script type="module">：
 *   生产页有 CSP（script-src 'self' app:），**内联脚本会被直接拦掉**（我踩过一次：
 *   页面一片空白、`window.__rigDiag` 是 null、控制台没有我们自己的日志）。
 *   外部文件走 'self' 就合法，也和 index.html + renderer.js 的现有结构一致。
 *
 * 依赖：window.pet（preload 暴露）——onMood / onDragMoved / notifyReady。
 */
import { createPet } from 'app://pet/vendor/web/kit/body.js'
import { createWhaleFigure } from 'app://pet/vendor/web/whale/figure.js'

// ---- 贴图路径重映射（上游布局 → 我们的扁平素材目录）----
const ASSET = new URL('app://pet/assets/')
const asset = (p) => {
  const s = String(p).replace(/^\.?\//, '')
  if (s.startsWith('schemes/')) return new URL(s, ASSET)
  return new URL(s.replace(/^(tex|feat)\//, ''), ASSET)
}

const diag = { ok: false, err: null, frames: 0, mood: null, rigScale: 1, scheme: null, size: null }
window.__rigDiag = diag

function fail(msg) {
  diag.err = String(msg)
  const el = document.getElementById('fallback')
  if (el) {
    el.style.display = 'flex'
    el.textContent = 'rig 起不来：' + msg + '\n（把 config.pet.renderer 改成 "frames" 可回退 PNG 帧）'
  }
  console.error('[rig]', msg)
}

let ctl = null
let last = 0
let talkUntil = 0

// ---- 铁盆（error 状态扣在头上）----
//
// frames 路线里 error 状态是"头上扣个铁盆"（素材 assets/raw/coopanion-whale/basin.png，128×64）。
// rig 这边没法"把道具合成进画"（角色是 WebGL 实时画的），所以用一张**绝对定位的 <img> 叠在画面上**，
// 按 `layout().box` 贴到头的位置 ⇒ 她走动 / 被拎起来 / 窗口缩放，盆都跟着头走，不需要重新烘焙素材。
//
// 参数集中在这里，调位置只改这一处（单位：box 的比例）。
// ⚠️ 这段刻意放在 frame/setMood **之前**：它们是 const，放后面会在初始化阶段踩 TDZ
//    （`typeof x === 'function'` 对 TDZ 的 const 也会抛错，挡不住）。
const BASIN = {
  // 实测标定（dizzy 坐姿，box = {x:28.4, y:33.3, w:115.3, h:132.7} CSS px）：
  //   · 她的头顶（发团最高处，不含呆毛）在 CSS y≈57 → (57-33.3)/132.7 ≈ 0.18
  //   · 头（发团）宽约 49~52 CSS px → 52/115.3 ≈ 0.45
  //   第一版用了 0.62 / 0.11，结果盆又大又浮在头顶上方一截（放大 4 倍看得清清楚楚）。
  widthRatio: 0.46,   // 盆宽 = 角色包围盒宽 × 这个值
  cxRatio: 0.5,       // 盆中心 x 在包围盒里的位置（0.5 = 正中）
  topRatio: 0.245,    // 盆**底沿**所在高度：包围盒顶 + 高度 × 这个值（越小越靠上）
  tilt: -7,           // 倾斜角（度），歪一点更可爱
}
const basinEl = document.getElementById('basin')
let basinOn = false
let basinTick = 0
/** 主进程下发的最后一个 mood（'error' 时铁盆归它管，摇晕的临时盆不该抢） */
let lastMood = 'idle'

function layoutBasin() {
  if (!basinEl || basinEl.hidden || !ctl) return
  let box
  try { box = ctl.layout().box } catch { return }
  if (!box || !box.w) return
  const w = box.w * BASIN.widthRatio
  const h = w * (64 / 128)                     // 素材是 128×64
  const cx = box.x + box.w * BASIN.cxRatio
  const bottom = box.y + box.h * BASIN.topRatio
  basinEl.style.left = Math.round(cx - w / 2) + 'px'
  basinEl.style.top = Math.round(bottom - h) + 'px'
  basinEl.style.width = Math.round(w) + 'px'
  basinEl.style.height = Math.round(h) + 'px'
  basinEl.style.transform = 'rotate(' + BASIN.tilt + 'deg)'
}

function setBasin(on) {
  if (!basinEl) return
  basinOn = !!on
  basinEl.hidden = !basinOn
  if (basinOn) layoutBasin()
}

/** 每 3 帧贴一次位置（跟着走动/被拎起/缩放走，开销可忽略） */
function basinFollow() {
  if (!basinOn) return
  if ((basinTick++ % 3) === 0) layoutBasin()
}

/** 自检/冒烟测试用：盆的状态 + 当前包围盒 */
window.__rigBasin = () => ({
  on: basinOn,
  rect: basinEl ? { left: basinEl.style.left, top: basinEl.style.top, width: basinEl.style.width, height: basinEl.style.height } : null,
  box: (() => { try { return ctl ? ctl.layout().box : null } catch { return null } })(),
})

function frame(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
  last = now
  // ⚠️ createPet 的 `step(dt)` **只管步进、不负责画**（createBody 的那层包装才连画一起做）
  //    ⇒ 必须自己再调一次 `render()`，否则 `#pet` 里连 canvas 都不会被创建（踩过：canvas:false）
  ctl.step(dt)
  ctl.render()
  diag.frames++
  if (now < talkUntil) ctl.talk()          // 说话时持续驱动口型
  basinFollow()                            // 铁盆跟着头（没显示时是空操作）
  requestAnimationFrame(frame)
}

// 主进程那 4 个 mood → kit 的调用。
// ⚠️ 用的都是 **createPet** 的接口（setRoam/holdRoam/setThinking/setListening/setExpr/talk），
//    不是 createBody 那层的 `set({...})` —— 两者长得像但不是一个对象（踩过：`ctl.set is not a function`）。
const MOOD = {
  idle: () => {
    ctl.setRoam('free')
    ctl.setThinking(false)
    ctl.setListening(false)
    ctl.setExpr('neutral')
  },
  thinking: () => {
    ctl.setRoam('off')
    ctl.holdRoam(60)
    ctl.setThinking(true)
    ctl.setExpr('thinking')
  },
  talking: () => {
    ctl.setRoam('off')
    ctl.holdRoam(60)
    ctl.setThinking(false)
    ctl.setExpr('happy', 2)
    talkUntil = performance.now() + 4000
  },
  error: () => {
    ctl.setRoam('off')
    ctl.setThinking(false)
    ctl.setExpr('dizzy', 3)
  },
}

function setMood(mood) {
  diag.mood = mood
  lastMood = mood
  const fn = MOOD[mood]
  if (fn && ctl) { try { fn() } catch (e) { console.warn('[rig] mood', mood, e) } }
  // 铁盆只在 error（= dizzy）状态出现
  setBasin(mood === 'error')
}
window.__rigSetMood = setMood
// 通用表情钩子：给冒烟测试 / 自检脚本逐张对比脸型用（M3a 调映射时要靠它）
window.__rigSetExpr = (n, sec) => { try { ctl.setExpr(n, sec ?? 60) } catch (e) { console.warn('[rig] setExpr', n, e) } }
/**
 * 手动推帧（给隐藏窗 / 截图用）。
 * ⚠️ 必须**按真时间间隔**一帧一帧推：figure 把脸画进一张 live texture 再上传给 WebGL，
 *    如果把 90 帧塞进同一个 JS 任务里死循环，浏览器没机会跑自己的微任务/rAF，
 *    贴图就停在上一张脸 ⇒ 截图出现"错位一帧"（我实测看到 love 位置是普通眼、surprised 位置是爱心眼）。
 */
window.__rigPump = async (n, ms = 16) => {
  for (let i = 0; i < n; i++) {
    ctl.step(1 / 60)
    ctl.render()
    await new Promise((r) => setTimeout(r, ms))
  }
  return n
}
window.__rigHold = () => { try { ctl.setRoam('off'); ctl.holdRoam(600) } catch { /* ignore */ } }

try {
  const params = new URLSearchParams(location.search)
  const scheme = params.get('scheme') || 'deepseek'
  const rigScale = Number(params.get('scale') || '1') || 1
  // ⚠️ 角色缩放**必须锚定"基准高度"**（气泡展开前的窗口高度），不能用实时高度：
  //    主进程显示多行气泡时会把窗口**向上撑高**（index.ts 的 bubbleExtra，实测加到 104px），
  //    如果 S 跟着实时高度算，角色就会被放大 60%（用户报的"点发送后小鲸鱼变大、过一会变回来"）。
  const baseH = Number(params.get('baseh') || '0') || 0
  diag.rigScale = rigScale
  diag.baseH = baseH

  const figure = await createWhaleFigure(undefined, { scheme, asset })
  diag.scheme = figure.scheme || scheme
  const stage = document.getElementById('stage')

  ctl = createPet(
    { petG: document.getElementById('pet'), shadowEl: document.getElementById('shadow'), fxG: document.getElementById('fx') },
    {
      figure,
      sfx: {},                       // 声音由我们自己的语音链路负责
      roam: 'free',
      bounds: () => {
        const r = stage.getBoundingClientRect()
        const hRef = baseH > 0 ? baseH : r.height        // 缩放锚定基准高度
        const S = (hRef * 0.8 / 256) * rigScale          // 256 = rig 的 logo 空间高度
        return { W: r.width, H: r.height, floorY: r.height - 6, S }
      },
    },
  )
  new ResizeObserver(() => ctl.resize()).observe(stage)
  ctl.resize()
  diag.size = { w: stage.clientWidth, h: stage.clientHeight }

  if (window.pet && typeof window.pet.onMood === 'function') window.pet.onMood(setMood)
  else console.warn('[rig] window.pet.onMood 不存在（浏览器直接打开时正常）')

  // ---- 拖动姿态：让 kit 真的把她"拎起来" ----
  //
  // 难点：我们拖的是**操作系统的窗口**（窗口跟着光标走），而 kit 的 drag 模式是
  // **页面内**的指针拖拽（pointerDown → 移动超过 6px → grab() → pointerMove 跟随）。
  // 窗口跟着光标跑，指针在页面里的相对位置几乎不变 ⇒ kit 永远看不到"移动"，不会 grab。
  //
  // 解法（全部用 kit 的公开 API，不碰内部状态）：
  //   1. 窗口真的开始移动时（我们自己累计 screen 位移 > 8px），喂一对
  //      pointerDown(身体上的点) + pointerMove(+8px) —— 越过 6px 阈值就 grab()；
  //   2. 之后**不再移动**指针：她就被拎在斯库夫点上，随窗口被"提着走"（腿悬空、>< 脸）；
  //   3. 松手用 `dropAt()` **平放**，别用 `pointerUp()` —— 后者按 samples 算速度，
  //      我们合成的那一下会被算成几百 px/s 的抛掷，她会飞出去。
  let heldMode = false
  const enterHeld = () => {
    if (heldMode) return
    try {
      const lay = ctl.layout()
      const hit = (lay.hit && lay.hit[0]) || { x: 128, y: 200 }
      ctl.pointerDown({ x: hit.x, y: hit.y })
      ctl.pointerMove({ x: hit.x + 8, y: hit.y })   // > 6px ⇒ grab()
      heldMode = ctl.pet && ctl.pet.mode === 'drag'
    } catch (e) {
      console.warn('[rig] enterHeld', e)
    }
  }
  const releaseHeld = () => {
    if (!heldMode) return
    heldMode = false
    try {
      const box = ctl.layout().box
      ctl.dropAt({ x: box.x + box.w / 2, y: box.y + box.h * 0.55 })
    } catch (e) {
      console.warn('[rig] releaseHeld', e)
    }
  }

  // ---- 摇一摇 → 晕（error 动画）----
  //
  // 玩法（用户 2026-10-17 提的）：**抓住她连续晃动 3 秒以上，停下就触发 error 动画**
  // （瘫坐 + 螺旋眼 + 头顶转星星 + 铁盆）。这是"实时动画"：姿势/表情/粒子都是程序化驱动的，
  // 不是预先烘焙的帧序列 —— 所以窗口尺寸、配色、摇多久都不会走样。
  //
  // 判据（别用"感觉"）：方向反转（左右或上下来回）累计够多次 + 移动够快，
  // 就在"摇"的状态里累计时长；累计 ≥ SHAKE_NEED_MS 就上膛（armed）。
  // 上膛后：**松手** 或 **停手 1.5 秒** 都会触发 —— 两种"停下"都算，不用猜用户怎么停。
  const SHAKE_NEED_MS = Number(params.get('shake') || '3000') || 3000
  const SHAKE = { minStep: 3, windowMs: 500, needRev: 3, stopMs: 1500 }
  let shk = { x: 0, y: 0, t: 0, dir: 0, rev: 0, ms: 0, armed: false }
  let shakeIdleTimer = null
  let dizzyTimer = null

  const resetShake = () => {
    shk = { x: 0, y: 0, t: 0, dir: 0, rev: 0, ms: 0, armed: false }
    if (shakeIdleTimer) { clearTimeout(shakeIdleTimer); shakeIdleTimer = null }
  }

  /** 触发 error 动画（晕），并让铁盆戴上 ~3 秒 */
  const dizzyFromShake = (msReported) => {
    if (dizzyFromShake.busy === true) return
    dizzyFromShake.busy = true
    shk.armed = false
    try { ctl.setExpr('dizzy', 3) } catch (e) { console.warn('[rig] dizzy', e) }
    setBasin(true)
    diag.lastDizzyAt = Date.now()
    console.info('[rig] 摇晕了（摇了 ' + (msReported ?? Math.round(shk.ms)) + 'ms）')
    if (dizzyTimer) clearTimeout(dizzyTimer)
    dizzyTimer = setTimeout(() => {
      dizzyFromShake.busy = false
      // 主进程真的处在 error 状态时，盆该留着（由 setMood 管），别抢它的活
      if (lastMood !== 'error') setBasin(false)
    }, 3000)
  }

  /** 每次窗口拖动时的指针采样（screenX/screenY 是"真实位移"，窗口跟着光标跑不影响它） */
  const feedShake = (e) => {
    const now = performance.now()
    if (!shk.t) { shk.x = e.screenX; shk.y = e.screenY; shk.t = now; return }
    const dx = e.screenX - shk.x
    const dy = e.screenY - shk.y
    const dt = now - shk.t
    shk.x = e.screenX; shk.y = e.screenY; shk.t = now
    if (dt <= 0 || Math.hypot(dx, dy) < SHAKE.minStep) return

    const dir = Math.sign(dx) || shk.dir
    if (shk.dir !== 0 && dir !== shk.dir) shk.rev++
    shk.dir = dir

    if (shk.rev >= SHAKE.needRev && dt < SHAKE.windowMs) {
      shk.ms += dt
      if (shk.ms >= SHAKE_NEED_MS && !shk.armed) {
        shk.armed = true
        console.info('[rig] 摇够了 ' + Math.round(shk.ms) + 'ms，松手或停手就晕')
      }
    }
    // 停手 1.5 秒也算"停下"
    if (shakeIdleTimer) clearTimeout(shakeIdleTimer)
    shakeIdleTimer = setTimeout(() => { if (shk.armed) dizzyFromShake() }, SHAKE.stopMs)
  }

  // 自检用：当前"摇"的进度 + 手动触发（不用真的摇 3 秒也能验动画）
  window.__rigShake = () => ({ ms: Math.round(shk.ms), armed: shk.armed, rev: shk.rev, need: SHAKE_NEED_MS })
  window.__rigDizzy = () => dizzyFromShake()
  window.__rigHeld = () => ({ held: heldMode, mode: ctl.pet ? ctl.pet.mode : null })

  // ---- 说话气泡 ----
  // 旧页（renderer.js）有、rig 页一开始漏了 ⇒ 表现为"她会说话但看不见字"（用户报的）。
  // 气泡的**空间**由主进程给（多行时 setBubbleExtra 把窗口向上撑高），这里只管逐字画。
  const bubbleEl = document.getElementById('bubble')
  let bubbleBuf = ''
  let bubbleHideTimer = null

  const bubbleOpen = () => {
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null }
    if (!bubbleEl) return
    bubbleEl.hidden = false
    bubbleEl.classList.remove('err')
    bubbleEl.classList.add('typing')
    bubbleEl.textContent = ''
    bubbleBuf = ''
  }
  const bubbleDelta = (d) => {
    if (!bubbleEl || typeof d !== 'string') return
    if (bubbleEl.hidden) bubbleOpen()
    bubbleBuf += d
    bubbleEl.textContent = bubbleBuf
    // 长回复超出 max-height 时，让气泡**始终显示最新的那几行**（末尾），
    // 而不是把后面的字裁掉 —— 旧页（renderer.js）没做这个，长回复会只看到开头。
    // 注意：气泡是 pointer-events:none，只能程序滚动，用户没法自己拖。
    bubbleEl.scrollTop = bubbleEl.scrollHeight
  }
  const bubbleFinish = (errText) => {
    if (!bubbleEl) return
    bubbleEl.classList.remove('typing')
    if (errText) {
      bubbleEl.classList.add('err')
      if (!bubbleBuf) bubbleEl.textContent = errText
    }
    // 留 9 秒再收（与旧页一致），别让用户还没看完就消失
    bubbleHideTimer = setTimeout(() => {
      bubbleEl.hidden = true
      bubbleEl.textContent = ''
      bubbleBuf = ''
    }, 9000)
  }

  if (window.pet) {
    if (typeof window.pet.onDelta === 'function') {
      window.pet.onDelta((p) => bubbleDelta(p && p.delta))
    }
    if (typeof window.pet.onDone === 'function') {
      window.pet.onDone((info) => bubbleFinish(info && info.blocked ? '（预算用尽）' : ''))
    }
    if (typeof window.pet.onError === 'function') {
      window.pet.onError((p) => bubbleFinish('出错了：' + ((p && p.message) || '未知')))
    }
    // 互动叙事小游戏用的"额外动作"通道：动态表情 / 聆听 / 思考 / **重开气泡**
    if (typeof window.pet.onExtra === 'function') {
      window.pet.onExtra((p) => {
        if (!p) return
        try {
          if (p.kind === 'expr' && p.name) ctl.setExpr(p.name, p.secs ?? 2)
          else if (p.kind === 'listening') ctl.setListening(Boolean(p.on))
          else if (p.kind === 'thinking') ctl.setThinking(Boolean(p.on))
          // 剧情每一拍要**换一句**，不能追加到上一拍后面（气泡是复用的，没有这个信号就会越积越长）
          else if (p.kind === 'bubble-reset') bubbleOpen()
        } catch (e) { console.warn('[rig] extra', p.kind, e) }
      })
    }
  }

  // 自检/冒烟测试用：读气泡当前内容
  window.__rigBubble = () => ({ hidden: !bubbleEl || bubbleEl.hidden, text: bubbleEl ? bubbleEl.textContent : null })

  // ---- 语音播放 + 口型 ----
  //
  // 音频由**页面**播（不是主进程），因为只有页面能拿到 `onended`：
  // 说话时长 = 音频时长 ⇒ 直接把它写进 `talkUntil`，`ctl.talk()` 就会跟着嘴动。
  // 主进程只负责"把 data URL 发过来"和"记一条播放完成"。
  let audioEl = null
  let audioId = null
  const stopAudio = () => {
    if (audioEl) {
      try { audioEl.pause(); audioEl.src = '' } catch { /* ignore */ }
      audioEl = null
    }
    audioId = null
    talkUntil = 0
  }
  const playAudio = (p) => {
    if (!p || !p.dataUrl) return
    stopAudio()
    audioId = p.id ?? null
    try {
      const a = new Audio(p.dataUrl)
      audioEl = a
      a.volume = 1
      // 立刻开口：不等 canplay，先按"预计时长"让嘴动起来（拿不到时长就先给 1.5 秒）
      a.addEventListener('loadedmetadata', () => {
        const ms = Number.isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : 1500
        talkUntil = performance.now() + ms
      })
      a.addEventListener('ended', () => {
        talkUntil = 0
        if (audioId !== null && window.pet && typeof window.pet.audioDone === 'function') {
          window.pet.audioDone({ id: audioId, ms: Math.round(a.duration * 1000) })
        }
        audioEl = null
        audioId = null
      })
      a.addEventListener('error', () => {
        talkUntil = 0
        console.warn('[rig] audio error', p.engine || '')
        audioEl = null
        audioId = null
      })
      void a.play().catch((e) => {
        console.warn('[rig] audio play blocked', e && e.message)
        talkUntil = 0
      })
    } catch (e) {
      console.warn('[rig] audio', e)
      talkUntil = 0
    }
  }
  if (window.pet && typeof window.pet.onAudioPlay === 'function') window.pet.onAudioPlay(playAudio)
  if (window.pet && typeof window.pet.onAudioStop === 'function') window.pet.onAudioStop(stopAudio)
  // 自检钩子
  window.__rigAudio = () => ({
    playing: Boolean(audioEl),
    id: audioId,
    talkMsLeft: Math.max(0, Math.round(talkUntil - performance.now()))
  })

  // ---- 交互：拖动 / 单击 / 双击 / 右键菜单 ----
  // 协议与「PNG 帧」那条路（renderer.js）**完全一致**，这样主进程一行都不用改。
  // ⚠️ 别省这一步：不接的话桌宠拖不动、右键也弹不出菜单（旧页有，rig 页一开始漏了）。
  const stageEl = document.getElementById('stage')
  let drag = null
  let lastClickAt = 0

  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    drag = { id: e.pointerId, sx: e.screenX, sy: e.screenY, moved: false }
    resetShake()
    shk.x = e.screenX; shk.y = e.screenY; shk.t = performance.now()
    // anchor=cursor 时主进程只用 pointer 做坐标校准；anchor 一并给上，切到 grab 也能用
    try { window.pet?.dragStart({ anchor: { x: e.clientX, y: e.clientY }, pointer: { x: e.clientX, y: e.clientY } }) } catch { /* ignore */ }
    try { stageEl.setPointerCapture(e.pointerId) } catch { /* 个别情况 capture 会失败，退化为窗口内拖 */ }
    e.preventDefault()
  })
  stageEl.addEventListener('pointermove', (e) => {
    if (!drag) return
    try { window.pet?.dragMove() } catch { /* ignore */ }
    // 真的开始"移动"了才让她被拎起来（纯点击不该触发 grab）
    if (!drag.moved && Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) > 8) {
      drag.moved = true
      enterHeld()
    }
    // 摇一摇的采样（只在真的拖起来之后算，免得普通点击/微动误触）
    if (drag.moved) feedShake(e)
  })
  stageEl.addEventListener('pointerup', (e) => {
    if (!drag) return
    const moved = drag.moved
    const shakeArmed = shk.armed
    const shakeMs = Math.round(shk.ms)
    try { stageEl.releasePointerCapture(drag.id) } catch { /* ignore */ }
    drag = null
    if (moved) releaseHeld()
    resetShake()
    // 摇了 3 秒以上：松手就晕（"停下"的另一种是停手不动，由 feedShake 的定时器管）
    if (shakeArmed) {
      setTimeout(() => dizzyFromShake(shakeMs), 260)   // 等她落地的动作起来再晕，衔接更自然
    }
    // 到底算"拖"还是"点"，由主进程判定（它读真实光标，比渲染层可靠）
    window.pet?.dragEnd?.().then((r) => {
      if (r && r.moved) return
      const now = Date.now()
      if (now - lastClickAt < 400) {        // 双击 → 开聊天窗（与旧页一致）
        lastClickAt = 0
        try { window.pet?.openChat?.() } catch { /* ignore */ }
      } else {
        lastClickAt = now
        try { ctl.setExpr('surprised', 0.4) } catch { /* ignore */ }
      }
    }).catch(() => { /* ignore */ })
    e.preventDefault()
  })
  stageEl.addEventListener('pointercancel', () => { drag = null })
  stageEl.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    try { window.pet?.showMenu?.() } catch { /* ignore */ }
  })

  requestAnimationFrame(frame)
  diag.ok = true
  try { window.pet?.notifyReady?.() } catch { /* ignore */ }
  window.__rig = ctl
} catch (e) {
  fail((e && e.stack) || e)
}
