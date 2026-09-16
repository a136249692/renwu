// 靠左对齐模式下新建内容自动滚动测试
// 提取 main.js 里的 scrollToBlocks 逻辑做纯函数断言：
// 验证触发条件、坐标计算、zoom 过滤、幂等保护、边界 clamp 等行为。
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// ── DOM 模拟 ──
function makeEl(id, rect, opts = {}) {
  const set = new Set(opts.classes || []);
  return {
    id,
    _rect: rect,
    offsetHeight: rect.height,
    classList: {
      contains: c => set.has(c),
      add: c => set.add(c),
      remove: c => set.delete(c),
    },
    getBoundingClientRect: () => rect,
  };
}

class FakeBoard {
  constructor(blocks) { this.blocks = blocks; }
  querySelector(sel) {
    const m = /^\.block\[data-id="(\d+)"\]$/.exec(sel);
    if (!m) return null;
    return this.blocks.find(b => String(b.id) === m[1]) || null;
  }
}

class FakeCanvas {
  constructor({ viewportHeight = 600, scrollTop = 0, canvasTop = 0 } = {}) {
    this.clientHeight = viewportHeight;
    this.scrollTop = scrollTop;
    this._canvasTop = canvasTop;
    this.scrollCalls = [];
  }
  getBoundingClientRect() {
    return {
      top: this._canvasTop, left: 0,
      bottom: this._canvasTop + this.clientHeight, right: 800,
      width: 800, height: this.clientHeight,
    };
  }
  scrollTo(opts) {
    this.scrollCalls.push(opts);
    if (typeof opts === "object" && "top" in opts) this.scrollTop = opts.top;
  }
}

// ── 移植自 main.js 的 scrollToBlocks（去 rAF，改返回状态供断言） ──
function scrollToBlocks(canvas, board, ids) {
  const valid = ids.filter(id => id != null);
  if (!valid.length) return { called: false, target: null, reason: "no-valid-ids" };
  let target = null;
  for (let i = valid.length - 1; i >= 0; i--) {
    const el = board.querySelector(`.block[data-id="${valid[i]}"]`);
    if (el && el.offsetHeight > 0 && !el.classList.contains("zoomed")) { target = el; break; }
  }
  if (!target) return { called: false, target: null, reason: "not-found" };
  const canvasRect = canvas.getBoundingClientRect();
  const elRect = target.getBoundingClientRect();
  const elTopInCanvas = elRect.top - canvasRect.top + canvas.scrollTop;
  const elBottomInCanvas = elTopInCanvas + elRect.height;
  const vpH = canvas.clientHeight;
  const MARGIN = 60;
  let scrollTop = elBottomInCanvas - vpH + MARGIN;
  if (scrollTop < 0) scrollTop = 0;
  if (elBottomInCanvas <= canvas.scrollTop + vpH && elTopInCanvas >= canvas.scrollTop) {
    return { called: false, target, reason: "already-visible", scrollTop };
  }
  canvas.scrollTo({ top: scrollTop, behavior: "smooth" });
  return { called: true, target, scrollTop };
}

// ── 触发条件测试 ──

test("appendIds 为空数组：不滚动", () => {
  const canvas = new FakeCanvas();
  const board = new FakeBoard([]);
  const r = scrollToBlocks(canvas, board, []);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "no-valid-ids");
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

test("appendIds 全为 null/undefined：不滚动", () => {
  const canvas = new FakeCanvas();
  const board = new FakeBoard([]);
  const r = scrollToBlocks(canvas, board, [null, undefined, null]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

test("所有 id 在 board 中不存在：不滚动", () => {
  const canvas = new FakeCanvas();
  const board = new FakeBoard([]);
  const r = scrollToBlocks(canvas, board, [1, 2, 3]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "not-found");
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

// ── zoom 过滤测试 ──

test("目标块是 zoomed 状态：跳过", () => {
  const canvas = new FakeCanvas();
  const zoomedEl = makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }, { classes: ["zoomed"] });
  const board = new FakeBoard([zoomedEl]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

test("zoomed 与新块混排：跳过 zoomed，选中普通新块", () => {
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0 });
  // 第一个是 zoomed（不应被选），第二个是普通新块（应被选）
  const zoomedEl = makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }, { classes: ["zoomed"] });
  const normalEl = makeEl(2, { top: 800, left: 20, height: 48, width: 200 });
  const board = new FakeBoard([zoomedEl, normalEl]);
  const r = scrollToBlocks(canvas, board, [1, 2]);
  assert.strictEqual(r.called, true);
  assert.strictEqual(r.target.id, 2, "选中普通新块 id=2，不是 zoomed 的 id=1");
});

// ── 坐标计算测试 ──

test("新块在视口下方：滚动把它带入视口下沿 + MARGIN", () => {
  // 视口 600px, scrollTop=0, canvasTop=0
  // block 在 canvas 内 y=1000（超出视口），屏幕 top = 1000
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, true);
  // elTopInCanvas = 1000 - 0 + 0 = 1000
  // elBottomInCanvas = 1048
  // scrollTop = 1048 - 600 + 60 = 508
  assert.strictEqual(r.scrollTop, 508);
  assert.strictEqual(canvas.scrollCalls[0].top, 508);
  assert.strictEqual(canvas.scrollCalls[0].behavior, "smooth");
});

test("新块部分可见（底部超出视口）：滚动", () => {
  // 视口 600, scrollTop=500, 视口内 canvas 范围 [500, 1100]
  // block 在 canvas 内 y=1050, height=80，屏幕 top = 1050 - 500 = 550
  // block 屏幕范围 [550, 630]，canvas 屏幕范围 [0, 600]，底部 30px 被截
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 500, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 550, left: 20, height: 80, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, true);
  // elTopInCanvas = 550 - 0 + 500 = 1050
  // elBottomInCanvas = 1130
  // scrollTop = 1130 - 600 + 60 = 590
  assert.strictEqual(r.scrollTop, 590);
});

test("新块正好在视口底部边缘：滚动", () => {
  // 视口 600, scrollTop=0
  // block 在 canvas y=580, height=40 → 屏幕 top=580, bottom=620（超出视口 20px）
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 580, left: 20, height: 40, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, true);
  // elBottomInCanvas = 620
  // scrollTop = 620 - 600 + 60 = 80
  assert.strictEqual(r.scrollTop, 80);
});

// ── 幂等保护测试 ──

test("新块已完整可见：不滚动", () => {
  // 视口 600, scrollTop=100, 视口内 canvas 范围 [100, 700]
  // block 在 canvas y=400, height=48 → 屏幕 top = 500, bottom = 548
  // block 完全在 [100, 700] 内
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 100, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 500, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "already-visible");
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

test("新块在视口最上端（scrollTop=0 时完全可见）：不滚动", () => {
  // 视口 600, scrollTop=0, 视口 [0, 600]
  // block 在 canvas y=100, height=48 → 完全在视口内
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 100, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "already-visible");
});

test("极端情况：scrollTop 算出来是负数（clamp 到 0），但块已可见所以不滚", () => {
  // 视口 600, scrollTop=100, 视口 [100, 700]
  // block 在 canvas y=120, height=48 → 完全在 [100, 700] 内
  // elTopInCanvas = 120, elBottomInCanvas = 168
  // scrollTop = 168 - 600 + 60 = -372 → clamp 到 0
  // 但已可见检查先拦截
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 100, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 220, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "already-visible");
});

// ── 多块选择测试 ──

test("多个 appendIds：选择最后一个可见的块（不是第一个）", () => {
  // 视口 600, scrollTop=0
  // 两个块都在视口下方，函数应选第二个（id=2）
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }),
    makeEl(2, { top: 1100, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1, 2]);
  assert.strictEqual(r.called, true);
  assert.strictEqual(r.target.id, 2);
  // 以 id=2 为准计算
  // elBottomInCanvas = 1100 + 48 = 1148
  // scrollTop = 1148 - 600 + 60 = 608
  assert.strictEqual(r.scrollTop, 608);
});

test("最后一个 id 不存在但前面的存在：回退到前面", () => {
  // 视口 600, scrollTop=0
  // id=2 在 board 中，id=99 不存在 → 选 id=2
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(2, { top: 800, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [2, 99]);
  assert.strictEqual(r.called, true);
  assert.strictEqual(r.target.id, 2);
});

test("所有 ids 都不可用（存在但 zoomed / 不存在混合）：不滚动", () => {
  const canvas = new FakeCanvas();
  const zoomedEl = makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }, { classes: ["zoomed"] });
  const board = new FakeBoard([zoomedEl]); // 只有 id=1，且 zoomed
  const r = scrollToBlocks(canvas, board, [1, 2, 3]); // id=2/3 都不存在
  assert.strictEqual(r.called, false);
  assert.strictEqual(canvas.scrollCalls.length, 0);
});

// ── 边界测试 ──

test("canvasTop 非 0 时坐标换算正确（canvas 在页面中部）", () => {
  // canvas 顶部屏幕 y=200，viewport 600
  // block 在 canvas 内 y=800, height=48
  // 屏幕 top = 200 + 800 - 0 = 1000（scrollTop=0）
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 0, canvasTop: 200 });
  const board = new FakeBoard([
    makeEl(1, { top: 1000, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, true);
  // elTopInCanvas = 1000 - 200 + 0 = 800
  // elBottomInCanvas = 848
  // scrollTop = 848 - 600 + 60 = 308
  assert.strictEqual(r.scrollTop, 308);
});

test("canvas 已在底部滚动位置：不越过最大值", () => {
  // 视口 600, scrollTop=5000, canvas 内容假设只有 5200px
  // block 在 canvas y=5100, height=48, 屏幕 top = 5100 - 5000 = 100
  // 视口范围 [5000, 5600]，block canvas 内 [5100, 5148] 完全可见
  const canvas = new FakeCanvas({ viewportHeight: 600, scrollTop: 5000, canvasTop: 0 });
  const board = new FakeBoard([
    makeEl(1, { top: 100, left: 20, height: 48, width: 200 }),
  ]);
  const r = scrollToBlocks(canvas, board, [1]);
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.reason, "already-visible");
});

// ── 输出 ──
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  const tag = r.pass ? "✓" : `✗ ${r.err}`;
  console.log(`  ${tag}  ${r.name}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
