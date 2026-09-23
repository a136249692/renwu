// 堆叠区排序：done / review 两段独立堆叠 + 三态切换 + 持久化 的逻辑测试
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

// ── normalizeStage（与前端一致） ──
function normalizeStage(s) {
  if (s === "review") return "review";
  if (s === "done") return "done";
  return "todo";
}

// ── 模拟 layoutStackedRows：通用堆叠区布局（stage: 'done' | 'review'）──
// 与 main.js 中的实现语义一致：
//   · 'date' 模式：按 createdAt 升序（旧→新）
//   · 'manual' 模式：按 y 位置排序
//   · originY 是该段的顶部起点 y
//   · insertB 为「刚拖入该区」的块：按 drop 时的 y 相对已有块的位置决定插入索引
function layoutStackedRows(blocks, stage, originY, insertB) {
  const mode = getDoneSortMode();
  const others = blocks.filter(b => normalizeStage(b.stage) === stage && b !== insertB).sort(
    mode === "manual" ? (a, b) => a.y - b.y : (a, b) => a.createdAt - b.createdAt
  );
  let insertIdx = others.length;
  if (insertB) {
    const dropCenter = insertB.y;
    for (let i = 0; i < others.length; i++) {
      const h = others[i].h || 44;
      if (dropCenter < others[i].y + h / 2) { insertIdx = i; break; }
    }
    others.splice(insertIdx, 0, insertB);
  }
  let cursor = originY;
  for (const b of others) {
    b.x = 20; b.row = true;
    const h = b.h || 44;
    b.y = cursor;
    cursor += h + 10;
  }
  return { list: others, total: others.length ? cursor - originY - 10 : 0 };
}

// ── 兼容旧调用：只堆叠 done 段 ──
function layoutDoneRows(blocks) {
  return layoutStackedRows(blocks, "done", 14).list;
}

// ── 模拟 persistAllStackedPositions ──
function makeStore() { return { saved: new Set() }; }
function persistAllStackedPositions(store, blocks) {
  for (const b of blocks) {
    const s = normalizeStage(b.stage);
    if (s === "done" || s === "review") store.saved.add(b.id);
  }
}
function persistBlockPosition(store, b) { store.saved.add(b.id); }

// ── 测试用例 ──

// 1. 默认按日期排序（done 段）
test("默认模式 date：按 createdAt 升序（旧→新）", () => {
  resetLS();
  const blocks = [
    { id: 3, stage: "done", createdAt: 300, h: 44 },
    { id: 1, stage: "done", createdAt: 100, h: 44 },
    { id: 2, stage: "done", createdAt: 200, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.deepStrictEqual(ordered.map(b => b.id), [1, 2, 3]);
});

// 2. 自由排序模式：按 y 位置
test("手动模式 manual：按 y 位置排序", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, stage: "done", createdAt: 100, y: 100, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 14, h: 44 },
    { id: 3, stage: "done", createdAt: 300, y: 50, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.deepStrictEqual(ordered.map(b => b.id), [2, 3, 1]);
});

// 3. 拖动后切到手动模式
test("拖动堆叠块后切换为 manual 模式", () => {
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
    { id: 1, stage: "done", createdAt: 100, y: 200, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 14, h: 44 },
    { id: 3, stage: "done", createdAt: 300, y: 68, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 2, "y=14 的块排第一");
  assert.strictEqual(ordered[1].id, 3, "y=68 的块排第二");
  assert.strictEqual(ordered[2].id, 1, "y=200 的块排第三");
  assert.strictEqual(ordered[0].y, 14);
  assert.strictEqual(ordered[1].y, 14 + 44 + 10);
  assert.strictEqual(ordered[2].y, 14 + 44 + 10 + 44 + 10);
});

// 5. 手动模式持久化：reload 后模式不变
test("手动模式持久化：localStorage 保存 mode，reload 后不变", () => {
  resetLS();
  setDoneSortMode("manual");
  assert.strictEqual(getDoneSortMode(), "manual");
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
    { id: 1, stage: "done", createdAt: 100, y: 14, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 68, h: 44 },
    { id: 3, stage: "todo", createdAt: 300, y: 500, h: 44 },
  ];
  // 块 3 被标记为 done（从 todo 推进到 done），手动模式下 y=999999
  blocks[2].stage = "done";
  blocks[2].row = true;
  blocks[2].x = 20;
  if (getDoneSortMode() === "manual") blocks[2].y = 999999;
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1);
  assert.strictEqual(ordered[1].id, 2);
  assert.strictEqual(ordered[2].id, 3, "新块排最后");
});

// 8. 自由排序模式下 relayout 后所有堆叠块落盘
test("自由排序模式下 relayout 后所有堆叠块落盘", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, stage: "done", createdAt: 100, y: 100, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 14, h: 44 },
    { id: 3, stage: "todo", createdAt: 300, y: 500, h: 44 },
  ];
  layoutDoneRows(blocks);
  persistAllStackedPositions(store, blocks);
  assert.ok(store.saved.has(1), "块1 是 done，应落盘");
  assert.ok(store.saved.has(2), "块2 是 done，应落盘");
  assert.ok(!store.saved.has(3), "块3 是 todo，不应落盘");
});

// 9. 拖到待完成区：done 段剩余块重排 + 本块自身落盘
test("拖到待完成区：done 段剩余块重排 + 本块自身落盘", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, stage: "done", createdAt: 100, y: 14, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 68, h: 44 },
  ];
  // 块 1 拖到待完成区
  blocks[0].stage = "todo";
  layoutDoneRows(blocks); // 块 2 重排
  persistAllStackedPositions(store, blocks); // 落盘块 2
  persistBlockPosition(store, blocks[0]);    // 落盘块 1（新坐标）
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

// 10. 从 done 退回 todo：剩余块重排
test("从 done 退回 todo：剩余块重排", () => {
  resetLS();
  setDoneSortMode("manual");
  const store = makeStore();
  const blocks = [
    { id: 1, stage: "done", createdAt: 100, y: 14, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 68, h: 44 },
  ];
  blocks[0].stage = "todo";
  blocks[0].row = false;
  blocks[0].x = 100; blocks[0].y = 300;
  layoutDoneRows(blocks);
  persistAllStackedPositions(store, blocks);
  persistBlockPosition(store, blocks[0]);
  assert.ok(store.saved.has(1));
  assert.ok(store.saved.has(2));
});

// 11. date 模式忽略 y 位置
test("date 模式忽略 y 位置，只看 createdAt", () => {
  resetLS();
  const blocks = [
    { id: 1, stage: "done", createdAt: 100, y: 200, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 14, h: 44 },
  ];
  const ordered = layoutDoneRows(blocks);
  assert.strictEqual(ordered[0].id, 1, "createdAt 决定顺序，不看 y");
  assert.strictEqual(ordered[1].id, 2);
});

// 12. 自由排序 reload 后顺序保持一致
test("自由排序 reload 后顺序保持不变", () => {
  resetLS();
  setDoneSortMode("manual");
  const fromDB = [
    { id: 1, stage: "done", createdAt: 100, y: 14, h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 68, h: 44 },
    { id: 3, stage: "done", createdAt: 300, y: 122, h: 44 },
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
    { id: 3, stage: "done", createdAt: 300, h: 44 },
    { id: 1, stage: "done", createdAt: 100, h: 44 },
    { id: 2, stage: "done", createdAt: 200, h: 44 },
  ];
  const ordered1 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  const ordered2 = layoutDoneRows(fromDB.map(b => ({ ...b })));
  assert.deepStrictEqual(ordered1.map(b => b.id), ordered2.map(b => b.id));
  assert.deepStrictEqual(ordered1.map(b => b.id), [1, 2, 3]);
});

// 14. 堆叠后 y 按高度递增，无重叠（两种模式通用）
test("两种模式下堆叠后 y 按高度递增，无重叠", () => {
  resetLS();
  const blocksD = [
    { id: 1, stage: "done", createdAt: 100, h: 46 },
    { id: 2, stage: "done", createdAt: 200, h: 52 },
    { id: 3, stage: "done", createdAt: 300, h: 40 },
  ];
  const orderedD = layoutDoneRows(blocksD);
  for (let i = 1; i < orderedD.length; i++) {
    assert.ok(orderedD[i].y >= orderedD[i - 1].y + orderedD[i - 1].h + 10, "date 模式无重叠");
  }
  resetLS();
  setDoneSortMode("manual");
  const blocksM = [
    { id: 1, stage: "done", createdAt: 100, y: 100, h: 46 },
    { id: 2, stage: "done", createdAt: 200, y: 14, h: 52 },
    { id: 3, stage: "done", createdAt: 300, y: 50, h: 40 },
  ];
  const orderedM = layoutDoneRows(blocksM);
  for (let i = 1; i < orderedM.length; i++) {
    assert.ok(orderedM[i].y >= orderedM[i - 1].y + orderedM[i - 1].h + 10, "manual 模式无重叠");
  }
});

// ── 新增：review 段独立堆叠 ──

// 15. review 段独立于 done 段：各自堆叠不交叉
test("review 段与 done 段独立堆叠", () => {
  resetLS();
  const blocks = [
    { id: 1, stage: "done",   createdAt: 100, y: 14,  h: 44 },
    { id: 2, stage: "review", createdAt: 200, y: 400, h: 44 },
    { id: 3, stage: "review", createdAt: 300, y: 450, h: 44 },
    { id: 4, stage: "done",   createdAt: 400, y: 500, h: 44 },
    { id: 5, stage: "todo",   createdAt: 500, y: 800, h: 44 },
  ];
  // done 段起点 = 14；review 段起点假设为 doneY + 16 = 100
  const doneRes = layoutStackedRows(blocks, "done", 14);
  const reviewRes = layoutStackedRows(blocks, "review", 100);
  assert.deepStrictEqual(doneRes.list.map(b => b.id), [1, 4], "done 段仅含 id 1,4");
  assert.deepStrictEqual(reviewRes.list.map(b => b.id), [2, 3], "review 段仅含 id 2,3");
  // y 值分段：done 从 14 起；review 从 100 起
  assert.strictEqual(doneRes.list[0].y, 14);
  assert.strictEqual(doneRes.list[1].y, 14 + 44 + 10);
  assert.strictEqual(reviewRes.list[0].y, 100);
  assert.strictEqual(reviewRes.list[1].y, 100 + 44 + 10);
});

// 16. review 段 date 模式：按 createdAt 升序
test("review 段 date 模式：按 createdAt 升序", () => {
  resetLS();
  const blocks = [
    { id: 3, stage: "review", createdAt: 300, h: 44 },
    { id: 1, stage: "review", createdAt: 100, h: 44 },
    { id: 2, stage: "review", createdAt: 200, h: 44 },
  ];
  const res = layoutStackedRows(blocks, "review", 100);
  assert.deepStrictEqual(res.list.map(b => b.id), [1, 2, 3]);
});

// 17. review 段 manual 模式：按 y 位置排序
test("review 段 manual 模式：按 y 位置排序", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, stage: "review", y: 300, h: 44 },
    { id: 2, stage: "review", y: 100, h: 44 },
    { id: 3, stage: "review", y: 200, h: 44 },
  ];
  const res = layoutStackedRows(blocks, "review", 100);
  assert.deepStrictEqual(res.list.map(b => b.id), [2, 3, 1]);
});

// 18. todo → review → done 阶段循环
test("toggleDone 三态循环：todo → review → done → todo", () => {
  resetLS();
  function nextStage(cur) {
    const s = normalizeStage(cur);
    if (s === "todo") return "review";
    if (s === "review") return "done";
    return "todo";
  }
  assert.strictEqual(nextStage("todo"), "review");
  assert.strictEqual(nextStage("review"), "done");
  assert.strictEqual(nextStage("done"), "todo");
  // 无效值兜底到 todo
  assert.strictEqual(nextStage("garbage"), "review");
  assert.strictEqual(nextStage(undefined), "review");
  assert.strictEqual(nextStage(null), "review");
});

// 19. 堆叠块插入：新拖入的块按 drop y 插入正确位置
test("插入模式：新拖入的块按 drop y 相对已有块决定插入索引", () => {
  resetLS();
  // 已有 3 个 done 块，date 模式（createdAt 升序：1,2,3）
  const existing = [
    { id: 1, stage: "done", createdAt: 100, y: 14,  h: 44 },
    { id: 2, stage: "done", createdAt: 200, y: 68,  h: 44 },
    { id: 3, stage: "done", createdAt: 300, y: 122, h: 44 },
  ];
  // 新拖入的块 4，drop y = 90（在 2 与 3 之间）
  const insertB = { id: 4, stage: "done", createdAt: 400, y: 90, h: 44 };
  const res = layoutStackedRows(existing, "done", 14, insertB);
  // 期望顺序：1, 2, 4, 3
  assert.deepStrictEqual(res.list.map(b => b.id), [1, 2, 4, 3]);
});

// 20. 全部堆叠块落盘：done + review 都落盘，todo 不落盘
test("persistAllStackedPositions：done 和 review 都落盘，todo 不落盘", () => {
  resetLS();
  const store = makeStore();
  const blocks = [
    { id: 1, stage: "done",   y: 14 },
    { id: 2, stage: "review", y: 100 },
    { id: 3, stage: "todo",   y: 400 },
    { id: 4, stage: "done",   y: 68 },
    { id: 5, stage: "review", y: 154 },
  ];
  persistAllStackedPositions(store, blocks);
  assert.ok(store.saved.has(1), "done 落盘");
  assert.ok(store.saved.has(2), "review 落盘");
  assert.ok(!store.saved.has(3), "todo 不落盘");
  assert.ok(store.saved.has(4), "done 落盘");
  assert.ok(store.saved.has(5), "review 落盘");
  assert.strictEqual(store.saved.size, 4);
});

// 21. 从 review 退回 todo 后再拖入 done：堆叠顺序保持一致
test("review → todo → done 跨段移动，堆叠顺序稳定", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, stage: "done", y: 14, h: 44 },
    { id: 2, stage: "done", y: 68, h: 44 },
  ];
  // 拖入 review 段一个块（drop 在段顶）
  const revB = { id: 3, stage: "review", y: 100, h: 44 };
  const revRes = layoutStackedRows(blocks, "review", 100, revB);
  assert.deepStrictEqual(revRes.list.map(b => b.id), [3]);
  // 再把 revB 从 review 退回 todo，然后重新拖到 done 段
  revB.stage = "todo";
  revB.y = 999999; // manual 模式：垫底
  revB.stage = "done";
  const doneRes = layoutStackedRows(blocks, "done", 14, revB);
  assert.deepStrictEqual(doneRes.list.map(b => b.id), [1, 2, 3], "revB 加入 done 段末尾");
});

// 22. done / review 两段共享同一 sort mode，但独立排序序列
test("done 和 review 段共享 sort mode 但独立排序", () => {
  resetLS();
  setDoneSortMode("manual");
  const blocks = [
    { id: 1, stage: "done",   createdAt: 100, y: 14,  h: 44 },
    { id: 2, stage: "done",   createdAt: 200, y: 100, h: 44 },
    { id: 3, stage: "review", createdAt: 100, y: 200, h: 44 },
    { id: 4, stage: "review", createdAt: 200, y: 100, h: 44 },
  ];
  const doneRes = layoutStackedRows(blocks, "done", 14);
  const reviewRes = layoutStackedRows(blocks, "review", 300);
  // done 段：y=14 → id 1；y=100 → id 2
  assert.deepStrictEqual(doneRes.list.map(b => b.id), [1, 2]);
  // review 段：y=100 → id 4；y=200 → id 3（createdAt 相同，y 不同）
  assert.deepStrictEqual(reviewRes.list.map(b => b.id), [4, 3]);
});

// 23. normalizeStage 兜底：未识别值归为 todo
test("normalizeStage 兜底：未识别值归为 todo", () => {
  assert.strictEqual(normalizeStage("todo"), "todo");
  assert.strictEqual(normalizeStage("review"), "review");
  assert.strictEqual(normalizeStage("done"), "done");
  assert.strictEqual(normalizeStage(undefined), "todo");
  assert.strictEqual(normalizeStage(null), "todo");
  assert.strictEqual(normalizeStage("garbage"), "todo");
  assert.strictEqual(normalizeStage(""), "todo");
});

// 24. review 段堆叠高度计算：total = sum(h + 10) - 10
test("review 段 total 高度计算正确", () => {
  resetLS();
  const blocks = [
    { id: 1, stage: "review", createdAt: 100, h: 50 },
    { id: 2, stage: "review", createdAt: 200, h: 60 },
    { id: 3, stage: "review", createdAt: 300, h: 40 },
  ];
  const res = layoutStackedRows(blocks, "review", 100);
  // total = (50+10) + (60+10) + (40+10) - 10 = 60 + 70 + 50 - 10 = 170
  assert.strictEqual(res.total, 170);
  // 空段：total = 0
  const emptyRes = layoutStackedRows([], "review", 100);
  assert.strictEqual(emptyRes.total, 0);
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
