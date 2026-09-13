// 已完成区排序：按日期排序 + 自由拖动排序共存 + 持久化 的逻辑测试
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// ── 模拟 localStorage ──
let lsStore = {};
const localStorage = {
  getItem(k) { return lsStore[k] ?? null; },
  setItem(k, v) { lsStore[k] = String(v); },
  removeItem(k) { delete lsStore[k]; },
};
function resetLS() { lsStore = {}; }

// ── 模拟排序模式 ──
const DONE_SORT_KEY = "glassCanvas.doneSort";
let activeFolderId = "1";
function getDoneSortMode() {
  try {
    const m = JSON.parse(lsStore[DONE_SORT_KEY] || "{}");
    return m[activeFolderId] || "date";
  } catch { return "date"; }
}
function setDoneSortMode(mode) {
  try {
    const m = JSON.parse(lsStore[DONE_SORT_KEY] || "{}");
    m[activeFolderId] = mode;
    lsStore[DONE_SORT_KEY] = JSON.stringify(m);
  } catch {}
}

// ── 模拟 layoutDoneRows（支持 date / manual 两种模式） ──
function layoutDoneRows(blocks) {
  const mode = getDoneSortMode();
  const doneList = blocks.filter(b => b.done).sort(
    mode === "manual" ? (a, b) => a.y - b.y : (a, b) => a.createdAt - b.createdAt
  );
  let cursor = 14;
  for (const b of doneList) {
    b.x = 20; b.row = true;
    const h = b.h || 44;
    b.y = cursor;
    cursor += h + 10;
  }
  return doneList;
}

// ── 模拟 persistAllDonePositions ──
function makeStore() { return { saved: new Set() }; }
function persistAllDonePositions(store, blocks) {
  for (const b of blocks) { if (b.done) store.saved.add(b.id); }
}
function persistBlockPosition(store, b) { store.saved.add(b.id); }

// ── 测试用例 ──

// 1. 默认按日期排序
test("默认模式 date：按 createdAt 升序（旧→新）", () => {
  resetLS();
  const blocks = [
    { id: 3, done: true, createdAt: 300, h: 44 },
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.deepStrictEqual(ordered.map(b => b.id), [1, 2, 3]);
});

// 2. 自由排序模式：按 y 位置
test("手动模式 manual：按 y 位置排序", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 44 },
    { id: 3, done: true, createdAt: 300, y: 50, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  // y 排序：2(14) → 3(50) → 1(100)，createdAt 被忽略
  assert.deepStrictEqual(ordered.map(b => b.id), [2, 3, 1]);
});

// 3. 拖动后切到手动模式
test("拖动已完成块后切换为 manual 模式", () => {
  resetLS();
  assert.strictEqual(getDoneSortMode(), "date", "初始为 date");
  setDoneSortMode("manual");
  assert.strictEqual(getDoneSortMode(), "manual", "拖动后变为 manual");
});

// 4. 自由排序模式下，拖动位置决定堆叠顺序
test("自由排序模式下拖动位置决定堆叠顺序", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 200, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 44 },
    { id: 3, done: true, createdAt: 300, y: 68, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 2, "y=14 的块排第一");
  assert.strictEqual(ordered[1].id, 3, "y=68 的块排第二");
  assert.strictEqual(ordered[2].id, 1, "y=200 的块排第三");
  // 验证堆叠 y 值递增
  assert.strictEqual(ordered[0].y, 14);
  assert.strictEqual(ordered[1].y, 14 + 44 + 10);
  assert.strictEqual(ordered[2].y, 14 + 44 + 10 + 44 + 10);
});

// 5. 手动模式持久化：reload 后模式不变
test("手动模式持久化：localStorage 保存 mode，reload 后不变", () => {
  resetLS();
  setDoneSortMode("manual");
  assert.strictEqual(getDoneSortMode(), "manual");
  // 模拟 reload：清空内存，从 localStorage 读
  activeFolderId = "1";
  assert.strictEqual(getDoneSortMode(), "manual", "reload 后仍为 manual");
});

// 6. 不同文件夹独立排序模式
test("不同文件夹有独立的排序模式", () => {
  resetLS();
  activeFolderId = "1";
  assert.strictEqual(getDoneSortMode(), "date");
  setDoneSortMode("manual");
  assert.strictEqual(getDoneSortMode(), "manual");
  activeFolderId = "2";
  assert.strictEqual(getDoneSortMode(), "date", "文件夹 2 仍为 date");
  setDoneSortMode("manual");
  activeFolderId = "1";
  assert.strictEqual(getDoneSortMode(), "manual", "文件夹 1 仍为 manual");
});

// 7. 自由排序模式下 toggleDone 新块放底部
test("自由排序模式下 toggleDone 新块放到底部", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 14, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 68, h: 44 },
    { id: 3, done: false, createdAt: 300, y: 500, h: 44 },
  ];
  // 块 3 被标记完成，手动模式下 y=999999
  blocks[2].done = true; blocks[2].row = true; blocks[2].x = 20;
  if (getDoneSortMode() === "manual") blocks[2].y = 999999;
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1);
  assert.strictEqual(ordered[1].id, 2);
  assert.strictEqual(ordered[2].id, 3, "新块排最后");
});

// 8. 自由排序模式下 relayout 后全部落盘
test("自由排序模式下 relayout 后所有块落盘", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 44 },
    { id: 3, done: false, createdAt: 300, y: 500, h: 44 },
  ];
  layoutDoneRows(blocks);
  persistAllDonePositions(store, blocks);
  assert.ok(store.saved.has(1), "块1 应落盘");
  assert.ok(store.saved.has(2), "块2 应落盘");
  assert.ok(!store.saved.has(3), "块3 是待完成，不应落盘");
});

// 9. 自由排序模式下拖到待完成区：done 块重排 + 自身落盘
test("自由排序模式下拖到待完成区：done 块重排 + 自身落盘", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 14, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 68, h: 44 },
  ];
  // 块 1 拖到待完成区
  blocks[0].done = false;
  layoutDoneRows(blocks); // 块 2 重排
  persistAllDonePositions(store, blocks); // 落盘块 2
  persistBlockPosition(store, blocks[0]);  // 落盘块 1（新坐标）
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

// 10. 自由排序模式下 toggleDone 取消完成：剩余块重排
test("自由排序模式下 toggleDone 取消完成：剩余块重排", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 14, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 68, h: 44 },
  ];
  blocks[0].done = false; blocks[0].row = false;
  blocks[0].x = 100; blocks[0].y = 300;
  layoutDoneRows(blocks);
  persistAllDonePositions(store, blocks);
  persistBlockPosition(store, blocks[0]);
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

// 11. date 模式忽略 y 位置
test("date 模式忽略 y 位置，只看 createdAt", () => {
  resetLS();
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 200, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1, "createdAt 决定顺序，不看 y");
  assert.strictEqual(ordered[1].id, 2);
});

// 12. 自由排序 reload 后顺序保持一致
test("自由排序 reload 后顺序保持不变", () => {
  resetLS();
  setDoneSortMode("manual");
  // 模拟从 DB 读回：y 已持久化
  const fromDB = [
    { id: 1, done: true, createdAt: 100, y: 14, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 68, h: 44 },
    { id: 3, done: true, createdAt: 300, y: 122, h: 44 },
  ];
  const ordered1 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  const ordered2 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  assert.deepStrictEqual(ordered1.map(b => b.id), ordered2.map(b => b.id), "两次排序结果相同");
  assert.deepStrictEqual(ordered1.map(b => b.id), [1, 2, 3]);
});

// 13. date 模式 reload 后顺序也保持一致
test("date 模式 reload 后顺序保持不变", () => {
  resetLS();
  const fromDB = [
    { id: 3, done: true, createdAt: 300, h: 44 },
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  const ordered1 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  const ordered2 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  assert.deepStrictEqual(ordered1.map(b => b.id), ordered2.map(b => b.id));
  assert.deepStrictEqual(ordered1.map(b => b.id), [1, 2, 3]);
});

// 14. 堆叠后 y 按高度递增，无重叠（两种模式通用）
test("两种模式下堆叠后 y 按高度递增，无重叠", () => {
  resetLS();
  // date 模式
  const blocksD = [
    { id: 1, done: true, createdAt: 100, h: 46 },
    { id: 2, done: true, createdAt: 200, h: 52 },
    { id: 3, done: true, createdAt: 300, h: 40 },
  ];
  const orderedD = layoutDoneRows(blocksD);
  for (let i = 1; i < orderedD.length; i++) {
    assert.ok(orderedD[i].y >= orderedD[i - 1].y + orderedD[i - 1].h + 10, "date 模式无重叠");
  }
  // manual 模式
  resetLS();
  setDoneSortMode("manual");
  const blocksM = [
    { id: 1, done: true, createdAt: 100, y: 100, h: 46 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 52 },
    { id: 3, done: true, createdAt: 300, y: 50, h: 40 },
  ];
  const orderedM = layoutDoneRows(blocksM);
  for (let i = 1; i < orderedM.length; i++) {
    assert.ok(orderedM[i].y >= orderedM[i - 1].y + orderedM[i - 1].h + 10, "manual 模式无重叠");
  }
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