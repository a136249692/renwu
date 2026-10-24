// 回归测试：图片夹卡片「描述栏挡住图片」BUG
// 用户诉求：图片按等比插入后，底部描述文字不应占用/遮住图片内容。
// 根因：it.height 表示图片的等比高度，但旧实现把它当成「卡片总高」，
//       而卡片是 flex 列布局（图片区 + 描述栏），wrap 被描述栏挤掉约 35px，
//       图片底部因此被裁掉/盖住。
// 修复不变量：
//   1) it.height 只表示图片区（wrap）高度；卡片总高 = wrap + 描述栏，自动撑开；
//   2) renderItems 下发 wrap 高度，并清掉卡片上的固定高度；
//   3) 缩放只改 wrap 高度，不把描述栏算进 it.height；
//   4) 图片用 contain 完整显示，不被裁切。
// 运行方式：node test/image-card-layout.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const IMG = fs.readFileSync(path.join(ROOT, "src/image-wall.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// 剥掉注释，避免注释里的关键字污染断言
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const IMG_CODE = stripComments(IMG);
const CSS_CODE = stripComments(CSS);

// ---------- renderItems：卡片不再写死总高度 ----------

test("renderItems 不再用 it.height 直接设置卡片总高度", () => {
  assert.ok(!/el\.style\.height\s*=\s*\(it\.height\s*\|\|\s*CARD_DEFAULT_W\)/.test(IMG_CODE),
    "卡片高度不应再等于 it.height（会把描述栏算进去）");
});

test("renderItems 清空卡片固定高度，交给内容自动撑开", () => {
  assert.ok(/el\.style\.height\s*=\s*""/.test(IMG_CODE),
    "renderItems 应把卡片高度置空，由 wrap + caption 决定总高");
});

test("renderItems 把 it.height 下发给 .card-img-wrap（图片区）", () => {
  const re = /const\s+wrapEl\s*=\s*el\.querySelector\("\.card-img-wrap"\)[\s\S]{0,200}?wrapEl\.style\.height\s*=\s*\(it\.height\s*\|\|\s*CARD_DEFAULT_W\)\s*\+\s*"px"/;
  assert.ok(re.test(IMG_CODE), "wrap 高度应等于 it.height（图片显示高度）");
});

// ---------- 缩放：只改图片区 ----------

test("startResize 改 wrap 高度，不再改卡片总高度", () => {
  const fn = IMG_CODE.slice(IMG_CODE.indexOf("function startResize"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(/wrapEl\.style\.height\s*=\s*it\.height\s*\+\s*"px"/.test(body),
    "缩放应更新 wrap 高度");
  assert.ok(!/el\.style\.height\s*=\s*it\.height/.test(body),
    "缩放不应把描述栏计入 it.height 后设到卡片总高");
});

test("startResize 的初始高度取 it.height，兜底取 wrap 实测高度", () => {
  assert.ok(/const\s+h0\s*=\s*it\.height\s*\|\|\s*\(wrapEl\s*\?\s*wrapEl\.offsetHeight\s*:\s*el\.offsetHeight\)/.test(IMG_CODE),
    "h0 应以 it.height 为准，避免从含描述栏的卡片总高起算");
});

// ---------- CSS：图片完整显示 ----------

test("card-img-wrap 使用 flex 居中（不再用 grid 自动行高）", () => {
  const block = CSS_CODE.slice(CSS_CODE.indexOf(".card-img-wrap"), CSS_CODE.indexOf(".card-img {"));
  assert.ok(/display:\s*flex/.test(block), "wrap 应为 flex 布局");
  assert.ok(!/display:\s*grid/.test(block), "wrap 不应再用 grid（grid 自动行高会让 img 用原始高度溢出）");
});

test("wrap 显式高度不再被 flex-grow 拉伸（flex: 0 0 auto）", () => {
  const block = CSS_CODE.slice(CSS_CODE.indexOf(".card-img-wrap"), CSS_CODE.indexOf(".card-img {"));
  assert.ok(/flex:\s*0\s+0\s+auto/.test(block), "wrap 不应 grow，高度以 JS 下发的图片高度为准");
});

test("card-img 使用 object-fit: contain，完整显示不裁切", () => {
  const block = CSS_CODE.slice(CSS_CODE.indexOf(".card-img {"));
  const body = block.slice(0, block.indexOf("}"));
  assert.ok(/object-fit:\s*contain/.test(body), "图片必须 contain 显示");
  assert.ok(/width:\s*100%/.test(body) && /height:\s*100%/.test(body),
    "图片应铺满 wrap 的宽高，再由 contain 内部等比留白");
});

// ---------- 自动整理：消除组内重叠 ----------

test("工具栏提供「整理」按钮，选中 ≥2 张时可用", () => {
  assert.ok(/id="image-tidy"/.test(HTML), "图片工具栏应有整理按钮");
  const sync = IMG_CODE.slice(IMG_CODE.indexOf("function syncImageToolbarBtns"));
  const body = sync.slice(0, sync.indexOf("\n}\n") + 3);
  assert.ok(/imageTidyBtn\.hidden = selection\.size < 2/.test(body),
    "只在选中 ≥2 张时显示整理按钮");
});

test("自动整理按网格排开、单元格含描述栏高度，保证不重叠", () => {
  const fn = IMG_CODE.slice(IMG_CODE.indexOf("function autoArrangeSelection"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(/Math\.ceil\(Math\.sqrt\(ordered\.length\)\)/.test(body),
    "应按近似方形网格分列");
  assert.ok(/const cellW = Math\.max/.test(body) && /const cellH = Math\.max/.test(body),
    "单元格应取选中项的最大尺寸");
  assert.ok(/\+ BG_CAPTION_H/.test(body), "行高必须包含底部描述栏，否则仍会压到下一张");
  assert.ok(/\(i % cols\) \* \(cellW \+ GAP\)/.test(body) &&
    /Math\.floor\(i \/ cols\) \* \(cellH \+ GAP\)/.test(body),
    "应按列/行 + 间距定位");
  assert.ok(/apiUpdateItem\(/.test(body), "整理后应落盘");
});

test("大组内的图片不参与手动整理（避免被容器重排覆盖）", () => {
  const fn = IMG_CODE.slice(IMG_CODE.indexOf("function autoArrangeSelection"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(/bigGroupForGroup\(gid\)/.test(body) && /请先拖出大组再整理/.test(body),
    "大组内图片应提示先拖出再整理");
});

// ---------- 输出 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  const tag = r.pass ? "✓" : `✗ ${r.err}`;
  console.log(`  ${tag}  ${r.name}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);