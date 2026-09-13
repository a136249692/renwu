// 已完成区拖动重排 + 状态保持的逻辑测试
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// ── 模拟 layoutDoneRows ──
// 按 b.y 排序（拖动后的位置），y 相同时按 createdAt tiebreaker
function layoutDoneRows(blocks) {
  const doneList = blocks.filter(b => b.done).sort((a, b) => a.y - b.y || a.createdAt - b.createdAt);
  let cursor = 14;
  for (const b of doneList) {
    b.x = 20; b.row = true;
    b.y = cursor;
    cursor += (b.h || 44) + 10;
  }
  return doneList;
}

// ── 模拟 onUp else 分支（状态没变） ──
function onUpElse(b, dividerY) {
  // 状态没变：在当前区域内移动
  if (b.done) {
    // 已完成区域内拖动 → relayout
    return { action: "relayout", b };
  } else {
    // 待完成区域内拖动 → 只更新坐标
    return { action: "move", b };
  }
}

// ── 测试用例 ──

test("已完成块按 y 排序：拖到最上方变成第一个", () => {
  const blocks = [
    { id: 1, done: true, y: 14, createdAt: 100, h: 44 },
    { id: 2, done: true, y: 70, createdAt: 200, h: 44 },
    { id: 3, done: true, y: 126, createdAt: 300, h: 44 },
  ];
  // 块 3 拖到 y=5（最上方）
  blocks[2].y = 5;
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 3, "块3应该在第一位");
  assert.strictEqual(ordered[1].id, 1);
  assert.strictEqual(ordered[2].id, 2);
  // 堆叠后 y 应该是 14, 68, 122
  assert.strictEqual(ordered[0].y, 14);
  assert.strictEqual(ordered[1].y, 68);
  assert.strictEqual(ordered[2].y, 122);
});

test("已完成块按 y 排序：拖到中间位置", () => {
  const blocks = [
    { id: 1, done: true, y: 14, createdAt: 100, h: 44 },
    { id: 2, done: true, y: 70, createdAt: 200, h: 44 },
    { id: 3, done: true, y: 126, createdAt: 300, h: 44 },
  ];
  // 块 3 拖到 y=40（在 1 和 2 之间）
  blocks[2].y = 40;
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1);
  assert.strictEqual(ordered[1].id, 3, "块3应该在第二位");
  assert.strictEqual(ordered[2].id, 2);
});

test("y 相同时按 createdAt tiebreaker", () => {
  const blocks = [
    { id: 1, done: true, y: 14, createdAt: 300, h: 44 },
    { id: 2, done: true, y: 14, createdAt: 100, h: 44 },
    { id: 3, done: true, y: 14, createdAt: 200, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 2, "createdAt 最小的排前面");
  assert.strictEqual(ordered[1].id, 3);
  assert.strictEqual(ordered[2].id, 1);
});

test("堆叠后无重叠：每个块的 y >= 前一块 y + h + 10", () => {
  const blocks = [
    { id: 1, done: true, y: 5, createdAt: 100, h: 46 },
    { id: 2, done: true, y: 80, createdAt: 200, h: 52 },
    { id: 3, done: true, y: 30, createdAt: 300, h: 40 },
  ];
  const ordered = layoutDoneRows(blocks);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    assert.ok(cur.y >= prev.y + prev.h + 10,
      `块${cur.id}(y=${cur.y}) 不应与块${prev.id}(y=${prev.y},h=${prev.h}) 重叠`);
  }
});

test("else 分支：已完成块在完成区内移动 → relayout，不删类名", () => {
  const b = { id: 1, done: true, y: 50 };
  const result = onUpElse(b, 200);
  assert.strictEqual(result.action, "relayout", "已完成块在完成区内移动应触发 relayout");
  assert.strictEqual(b.done, true, "done 状态不应改变");
});

test("else 分支：待完成块在待完成区内移动 → 只 move", () => {
  const b = { id: 1, done: false, y: 300 };
  const result = onUpElse(b, 200);
  assert.strictEqual(result.action, "move", "待完成块在待完成区内移动应只更新坐标");
  assert.strictEqual(b.done, false, "done 状态不应改变");
});

test("拖到待完成区（centerY >= dividerY）→ shouldDone=false → 状态改变", () => {
  const b = { id: 1, done: true, y: 250, h: 44 };
  const dividerY = 200;
  const centerY = b.y + b.h / 2;
  const shouldDone = centerY < dividerY;
  assert.strictEqual(shouldDone, false, "拖到分界线下方应判定为待完成");
  assert.ok(shouldDone !== b.done, "状态应改变");
});

test("拖到完成区（centerY < dividerY）→ shouldDone=true → 状态不变", () => {
  const b = { id: 1, done: true, y: 100, h: 44 };
  const dividerY = 200;
  const centerY = b.y + b.h / 2;
  const shouldDone = centerY < dividerY;
  assert.strictEqual(shouldDone, true);
  assert.strictEqual(shouldDone !== b.done, false, "状态不应改变");
});

test("拖回完成区内的不同位置 → 触发重排 → 新顺序落盘", () => {
  const blocks = [
    { id: 1, done: true, y: 14, createdAt: 100, h: 44 },
    { id: 2, done: true, y: 68, createdAt: 200, h: 44 },
    { id: 3, done: true, y: 122, createdAt: 300, h: 44 },
  ];
  // 块 1 拖到块 2 和 3 之间
  blocks[0].y = 90;
  const result = onUpElse(blocks[0], 200);
  assert.strictEqual(result.action, "relayout");
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 2, "块2升到第一位");
  assert.strictEqual(ordered[1].id, 1, "块1在第二位");
  assert.strictEqual(ordered[2].id, 3);
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
