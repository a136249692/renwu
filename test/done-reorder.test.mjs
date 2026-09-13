// 已完成区排序持久化 + 按日期排序的逻辑测试
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// ── 模拟 layoutDoneRows（按 createdAt 升序） ──
function layoutDoneRows(blocks) {
  const doneList = blocks.filter(b => b.done).sort((a, b) => a.createdAt - b.createdAt);
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
function makeStore() {
  return { saved: new Set() };
}
function persistAllDonePositions(store, blocks) {
  for (const b of blocks) {
    if (b.done) store.saved.add(b.id);
  }
}
function persistBlockPosition(store, b) {
  store.saved.add(b.id);
}

// ── 测试用例 ──

test("按 createdAt 升序：从远到近（旧→新）", () => {
  const blocks = [
    { id: 3, done: true, createdAt: 300, h: 44 },
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1, "最早创建的排第一");
  assert.strictEqual(ordered[1].id, 2);
  assert.strictEqual(ordered[2].id, 3, "最新创建的排最后");
});

test("堆叠后 y 按高度递增，无重叠", () => {
  const blocks = [
    { id: 1, done: true, createdAt: 100, h: 46 },
    { id: 2, done: true, createdAt: 200, h: 52 },
    { id: 3, done: true, createdAt: 300, h: 40 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].y, 14);
  assert.strictEqual(ordered[1].y, 14 + 46 + 10);
  assert.strictEqual(ordered[2].y, 14 + 46 + 10 + 52 + 10);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].y >= ordered[i - 1].y + ordered[i - 1].h + 10);
  }
});

test("relayout 后所有已完成块都落盘", () => {
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
    { id: 3, done: false, createdAt: 300, h: 44 },
  ];
  layoutDoneRows(blocks);
  persistAllDonePositions(store, blocks);
  assert.ok(store.saved.has(1), "块1 应落盘");
  assert.ok(store.saved.has(2), "块2 应落盘");
  assert.ok(!store.saved.has(3), "块3 是待完成，不应在 persistAllDonePositions 中落盘");
});

test("拖到待完成区：done 块 + 自身坐标都落盘", () => {
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  // 块1 拖到待完成区
  blocks[0].done = false;
  layoutDoneRows(blocks); // 块2 重排
  persistAllDonePositions(store, blocks); // 落盘块2
  persistBlockPosition(store, blocks[0]); // 落盘块1（新坐标）
  assert.ok(store.saved.has(1), "块1 自身坐标应落盘");
  assert.ok(store.saved.has(2), "块2 重排后坐标应落盘");
});

test("toggleDone 标记完成：所有 done 块落盘", () => {
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: false, createdAt: 200, h: 44 },
  ];
  // 块2 被标记为完成
  blocks[1].done = true; blocks[1].row = true; blocks[1].x = 20;
  layoutDoneRows(blocks);
  persistAllDonePositions(store, blocks);
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

test("toggleDone 取消完成：剩余 done 块 + 自身落盘", () => {
  const store = makeStore();
  const blocks = [
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  // 块1 被取消完成
  blocks[0].done = false; blocks[0].row = false;
  blocks[0].x = 100; blocks[0].y = 300;
  layoutDoneRows(blocks); // 块2 重排
  persistAllDonePositions(store, blocks); // 落盘块2
  persistBlockPosition(store, blocks[0]); // 落盘块1（新坐标）
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

test("排序与拖动位置无关：只看 createdAt", () => {
  const blocks = [
    { id: 1, done: true, createdAt: 100, y: 200, h: 44 },
    { id: 2, done: true, createdAt: 200, y: 14, h: 44 },
  ];
  // 块1 的 y=200（在下面），块2 的 y=14（在上面）
  // 但按 createdAt 排序，块1 先（createdAt=100 < 200）
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1, "createdAt 决定顺序，不看 y");
  assert.strictEqual(ordered[1].id, 2);
  assert.strictEqual(ordered[0].y, 14, "堆叠后块1 在最上面");
});

test("reload 后顺序不变：createdAt 确定性排序", () => {
  // 模拟从 DB 读回 3 个已完成块
  const fromDB = [
    { id: 3, done: true, createdAt: 300, h: 44 },
    { id: 1, done: true, createdAt: 100, h: 44 },
    { id: 2, done: true, createdAt: 200, h: 44 },
  ];
  const ordered1 = layoutDoneRows([...fromDB.map(b => ({...b}))]);
  const ordered2 = layoutDoneRows([...fromDB.map(b => ({...b}))]);
  assert.deepStrictEqual(
    ordered1.map(b => b.id),
    ordered2.map(b => b.id),
    "两次排序结果相同"
  );
  assert.deepStrictEqual(ordered1.map(b => b.id), [1, 2, 3]);
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
