// 任务夹滚动位置记忆恢复测试（重开回顶 BUG 的回归）
// 移植 main.js 里 restoreScroll / saveScroll / _applyRestoreTarget 的状态机，
// 断言「目标值 + 多帧重试 + 稳定前不回写」这几条关键不变量：
//   1. 内容高度尚未就绪时，浏览器 clamp 出的假 0 绝不能覆盖真实记忆；
//   2. 恢复期内到来的 scroll 事件不回写；force（切夹/关闭）仍可写入；
//   3. 内容高度就绪后目标位置被应用，恢复结束；
//   4. 恢复结束后正常滚动回写真实位置。
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

const SCROLL_KEY = "glassCanvas.scroll";

// ── DOM / storage 模拟 ──
class FakeCanvas {
  constructor({ clientHeight = 600, scrollHeight = 5000 } = {}) {
    this.clientHeight = clientHeight;
    this.scrollHeight = scrollHeight;
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }
  // 模拟浏览器写入 scrollTop 时的 clamp 行为
  set top(v) { this._top = v; }
  get top() { return this._top; }
}
// 用属性代理实现 clamp：直接赋值 scrollTop 会被夹到 [0, max]
function makeCanvas(opts) {
  const c = new FakeCanvas(opts);
  Object.defineProperty(c, "scrollTop", {
    get() { return c._st || 0; },
    set(v) {
      const max = Math.max(0, c.scrollHeight - c.clientHeight);
      c._st = Math.min(Math.max(0, v), max);
    },
  });
  Object.defineProperty(c, "scrollLeft", {
    get() { return c._sl || 0; },
    set(v) { c._sl = v; },
  });
  return c;
}

function makeStore() {
  const mem = {};
  return {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
  };
}

// ── 移植的状态机 ──
function makeScroller({ canvas, storage, activeFolderId = 1 }) {
  const _scrollMap = () => {
    try { return JSON.parse(storage.getItem(SCROLL_KEY) || "{}"); }
    catch { return {}; }
  };
  const state = {
    targetX: 0, targetY: 0, active: false, lockUntil: 0,
  };
  function _endRestore(now) {
    state.active = false;
    state.lockUntil = now() + 400;
  }
  function _applyRestoreTarget(now) {
    if (!state.active || activeFolderId == null) return;
    if (!canvas.clientHeight) return;
    const max = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
    canvas.scrollLeft = state.targetX;
    canvas.scrollTop = Math.min(state.targetY, max);
    if (max + 1 >= state.targetY) _endRestore(now);
  }
  function restoreScroll(now) {
    if (activeFolderId == null) return;
    let s;
    try { s = _scrollMap()[String(activeFolderId)] || { x: 0, y: 0 }; }
    catch { s = { x: 0, y: 0 }; }
    state.targetX = s.x || 0;
    state.targetY = s.y || 0;
    state.active = true;
    state.lockUntil = now() + 1200;
    _applyRestoreTarget(now);
  }
  function saveScroll(force, now) {
    if (activeFolderId == null) return;
    if (!force && (state.active || now() < state.lockUntil)) return;
    const map = _scrollMap();
    const x = state.active ? state.targetX : canvas.scrollLeft;
    const y = state.active ? state.targetY : canvas.scrollTop;
    map[String(activeFolderId)] = { x, y };
    storage.setItem(SCROLL_KEY, JSON.stringify(map));
  }
  return { state, restoreScroll, saveScroll, _applyRestoreTarget, _endRestore };
}

function seed(storage, id, x, y) {
  storage.setItem(SCROLL_KEY, JSON.stringify({ [String(id)]: { x, y } }));
}

// ── 用例 ──

test("首次打开（无记忆）：目标归零，恢复期结束于锁定窗口", () => {
  const storage = makeStore();
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 5000 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);
  assert.strictEqual(s.state.targetY, 0);
  assert.strictEqual(canvas.scrollTop, 0);
  // max(4400)+1 >= 0 → 立即结束
  assert.strictEqual(s.state.active, false);
});

test("内容高度不足：不把 clamp 的 0 回写覆盖真实记忆", () => {
  const storage = makeStore();
  seed(storage, 1, 0, 1500);                       // 真实记忆 = 1500
  // 内容尚未撑开，max=0 → 目标 1500 被 clamp 到 0
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 300 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);
  assert.strictEqual(canvas.scrollTop, 0, "clamp 假位置");
  assert.strictEqual(s.state.active, true, "内容不足 → 恢复未结束");

  // 此间到来的 scroll 事件触发 saveScroll（非 force）→ 必须被抑制
  s.saveScroll(false, () => t + 50);
  assert.deepStrictEqual(JSON.parse(storage.getItem(SCROLL_KEY)),
    { "1": { x: 0, y: 1500 } }, "真实记忆 1500 未被假 0 覆盖");
});

test("内容高度不足时的 force 保存：写入目标值而非 clamp 假值", () => {
  const storage = makeStore();
  seed(storage, 1, 0, 1500);
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 300 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);
  // 关闭窗口（force）：应记录「目标值」1500，而不是当前被 clamp 的 0
  s.saveScroll(true, () => t + 10);
  assert.deepStrictEqual(JSON.parse(storage.getItem(SCROLL_KEY)),
    { "1": { x: 0, y: 1500 } });
});

test("内容就绪后：目标位置被应用且恢复结束", () => {
  const storage = makeStore();
  seed(storage, 1, 0, 1500);
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 300 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);            // 此时内容不足，停在 0
  assert.strictEqual(canvas.scrollTop, 0);
  // 数据/布局晚到：内容撑高
  canvas.scrollHeight = 5000;
  s._applyRestoreTarget(() => t + 80);
  assert.strictEqual(canvas.scrollTop, 1500, "重试后到位");
  assert.strictEqual(s.state.active, false, "恢复结束");
});

test("恢复期内 scroll 事件不回写；结束后正常回写真实位置", () => {
  const storage = makeStore();
  seed(storage, 1, 0, 1500);
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 5000 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);
  // 内容充足 → 到位并结束，进入 400ms 锁定
  assert.strictEqual(canvas.scrollTop, 1500);
  assert.strictEqual(s.state.active, false);
  // 锁定窗口内的 scroll 事件仍不回写
  storage.removeItem(SCROLL_KEY);
  s.saveScroll(false, () => t + 200);
  assert.strictEqual(storage.getItem(SCROLL_KEY), null, "锁定窗口内不回写");
  // 锁定窗口过后，用户滚到 800 → 回写
  canvas.scrollTop = 800;
  s.saveScroll(false, () => t + 500);
  assert.deepStrictEqual(JSON.parse(storage.getItem(SCROLL_KEY)),
    { "1": { x: 0, y: 800 } });
});

test("切换文件夹 force 保存：恢复期内也落库（避免快速切夹丢失上一夹位置）", () => {
  const storage = makeStore();
  seed(storage, 1, 0, 1500);
  const canvas = makeCanvas({ clientHeight: 600, scrollHeight: 300 });
  const s = makeScroller({ canvas, storage });
  let t = 1000;
  s.restoreScroll(() => t);
  s.saveScroll(true, () => t + 5);
  assert.deepStrictEqual(JSON.parse(storage.getItem(SCROLL_KEY)),
    { "1": { x: 0, y: 1500 } }, "fetch force 保存目标值，不丢上一夹记忆");
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