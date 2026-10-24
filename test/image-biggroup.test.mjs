// 回归测试：图片夹「大组」与按组幻灯片放映
// 需求：在图片夹里创建「大组」容器，把已分组的图片整组拖进大组；
//       双击大组内的图片组，以幻灯片方式按组逐张放映。
// 运行方式：node test/image-biggroup.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const JS = fs.readFileSync(path.join(ROOT, "src/image-wall.js"), "utf8");

const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const CSS_CODE = stripComments(CSS);
const JS_CODE = stripComments(JS);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}
const cssBlock = sel => {
  const start = CSS_CODE.indexOf(sel);
  if (start < 0) return "";
  return CSS_CODE.slice(start, CSS_CODE.indexOf("}", start) + 1);
};
// 截取一个顶层 function 的函数体（到下一个 "\n}\n" 为止）
const fnBody = name => {
  const i = JS_CODE.indexOf(`function ${name}`);
  if (i < 0) return "";
  const body = JS_CODE.slice(i);
  return body.slice(0, body.indexOf("\n}\n") + 3);
};

// ---------- 结构与入口 ----------

test("图片工具栏提供「新建大组」按钮", () => {
  assert.ok(/id="image-biggroup"/.test(HTML), "缺少 #image-biggroup 按钮");
  assert.ok(/新建大组/.test(HTML), "按钮文案应包含「新建大组」");
  assert.ok(/imageBigGroupBtn\.addEventListener\("click", createBigGroup\)/.test(JS_CODE),
    "点击按钮应创建大组");
});

test("页面包含幻灯片 DOM 且默认收起", () => {
  assert.ok(/id="image-slideshow"[^>]*hidden/.test(HTML), "#image-slideshow 默认应 hidden");
  for (const id of ["slideshow-backdrop", "slideshow-title", "slideshow-counter",
    "slideshow-img", "slideshow-caption", "slideshow-prev", "slideshow-next", "slideshow-close"]) {
    assert.ok(new RegExp(`id="${id}"`).test(HTML), `缺少 #${id}`);
  }
});

// ---------- 数据层 ----------

test("大组按图片夹分开持久化到 localStorage", () => {
  assert.ok(/const BIG_GROUPS_KEY = "glassCanvas\.imageBigGroups"/.test(JS_CODE),
    "缺少大组存储键");
  const persist = fnBody("persistBigGroups");
  assert.ok(/bigGroupsMap\[String\(activeFolderId\)\] = bigGroups/.test(persist),
    "应按当前夹 id 写入");
});

test("切换图片夹时在图片就绪后再加载大组（避免误清理组）", () => {
  const body = fnBody("setActiveFolder");
  const loadItems = body.indexOf("items = await apiListItems");
  const loadBig = body.indexOf("loadBigGroupsForFolder");
  assert.ok(loadItems > 0 && loadBig > loadItems,
    "loadBigGroupsForFolder 必须在 items 加载之后调用（prune 依赖当前夹图片）");
});

test("一个组只归属一个大组，加入新大组时从旧大组移除", () => {
  const body = fnBody("addGroupsToBigGroup");
  assert.ok(/for \(const other of bigGroups\)/.test(body), "应遍历其他大组");
  assert.ok(/other\.groupIds = kept/.test(body) && /!toAdd\.includes\(gid\)/.test(body),
    "应从其他大组中剔除被移走的组");
  assert.ok(/layoutBigGroup\(bg, \{ persist: false \}\)/.test(body), "加入后应重新排布组内图片");
  assert.ok(/persistBigGroups\(\)/.test(body), "加入后应持久化");
});

test("大组默认名称与尺寸", () => {
  const body = fnBody("createBigGroup");
  assert.ok(/name: `大组 \$\{bigGroups\.length \+ 1\}`/.test(body), "默认名应为「大组 N」");
  assert.ok(/h: 300/.test(body) && /Math\.min\(560/.test(body), "默认尺寸应约 560×300");
  assert.ok(/groupIds: \[\]/.test(body), "新建时组列表应为空");
});

// ---------- 拖组入大组 ----------

test("把已分组的图片拖进大组容器 → 整组加入", () => {
  const drag = JS_CODE.slice(JS_CODE.indexOf("const up = () => {", JS_CODE.indexOf("function startCardDrag")));
  const body = drag.slice(0, drag.indexOf("};") + 2);
  assert.ok(/bigGroupAtClient\(lastX, lastY\)/.test(body), "松手时应判断是否落在大组容器内");
  assert.ok(/groupForItem\(d\.it\.id\)/.test(body), "应收集被拖动图片所属分组");
  assert.ok(/addGroupsToBigGroup\(target, gids\)/.test(body), "应把整组加入目标大组");
});

test("屏幕坐标命中大组容器换算正确", () => {
  const body = fnBody("bigGroupAtClient");
  assert.ok(/imageCanvas\.getBoundingClientRect\(\)/.test(body), "应取画布边界");
  assert.ok(/\(clientX - r\.left - view\.x\) \/ view\.zoom/.test(body), "X 应按平移/缩放换算");
  assert.ok(/wx >= bg\.x && wx <= bg\.x \+ bg\.w/.test(body), "应做容器范围命中判断");
});

// ---------- 渲染 ----------

test("容器内按组渲染子区域并显示组序号/张数", () => {
  const body = fnBody("renderBigGroupSubs");
  assert.ok(/class="big-group-sub"/.test(body), "应渲染 .big-group-sub");
  assert.ok(/data-gid="\$\{esc\(gid\)\}"/.test(body), "子区域应带 data-gid");
  assert.ok(/组 \$\{idx \+ 1\} · \$\{members\.length\} 张/.test(body), "标签应显示组序号与张数");
  assert.ok(/class="big-group-play"/.test(body), "标签内应提供 ▶ 放映按钮");
  assert.ok(/big-group-meta/.test(body) && /组 · \$\{total\} 张/.test(body), "标题栏应统计组数与张数");
});

test("容器点击穿透到卡片，子区域恢复点击", () => {
  assert.ok(/pointer-events:\s*none/.test(cssBlock(".big-group-body")), "body 应让点击穿透");
  assert.ok(/pointer-events:\s*auto/.test(cssBlock(".big-group-sub")), "子区域应恢复点击");
  assert.ok(/position:\s*absolute/.test(cssBlock(".big-group")), "容器应绝对定位在画布上");
});

test("拖动标题栏时容器与组内图片整体平移", () => {
  const body = fnBody("bindBigGroupEvents");
  assert.ok(/bigGroupItems\(bg\)\.map\(it => \(\{ it, x: it\.x, y: it\.y/.test(body),
    "拖动开始应记录所有组内图片初始位置");
  assert.ok(/s\.it\.x = s\.x \+ dx/.test(body) && /s\.it\.y = s\.y \+ dy/.test(body),
    "组内图片应随容器同步位移");
});

test("删除大组只删容器，不删除图片", () => {
  const body = fnBody("bindBigGroupEvents");
  const del = body.slice(body.indexOf('del.addEventListener("click"'));
  assert.ok(/bigGroups\.splice\(idx, 1\)/.test(del), "点击 × 应只移除大组条目");
  assert.ok(/persistBigGroups\(\)/.test(del), "删除后应持久化");
  assert.ok(!/deleteItem|apiDelete/.test(del), "删除大组不应删除图片");
  assert.ok(/图片保留/.test(del), "提示应说明图片保留");
});

test("整组拖到容器外时自动移出大组（不留半脱离状态）", () => {
  const drag = JS_CODE.slice(JS_CODE.indexOf("const up = () => {", JS_CODE.indexOf("function startCardDrag")));
  const body = drag.slice(0, drag.indexOf("};") + 2);
  assert.ok(/else if \(gids\.size\) \{\s*removeGroupsFromBigGroup\(gids\)/.test(body),
    "拖到容器外应调用 removeGroupsFromBigGroup");
  const fn = fnBody("removeGroupsFromBigGroup");
  assert.ok(/bg\.groupIds = kept/.test(fn), "应从大组中剔除这些组");
  assert.ok(/layoutBigGroup\(bg, \{ persist: false \}\)/.test(fn), "移出后应重排剩余组");
  assert.ok(/persistBigGroups\(\)/.test(fn), "移出后应持久化");
});

test("容器内挪动：重排且不再弹「已经在这个大组里」", () => {
  const body = fnBody("addGroupsToBigGroup");
  const early = body.slice(body.indexOf("if (!toAdd.length)"), body.indexOf("const touched"));
  assert.ok(/layoutBigGroup\(bg\)/.test(early) && /renderBigGroups\(\)/.test(early),
    "已在容器内时应重排并重绘（虚线框跟随图片）");
  assert.ok(!/toast\(/.test(early), "已在容器内时不应提示");
});

test("容器高度随组数量自动回缩，手动缩放后保留手动高度", () => {
  const body = fnBody("layoutBigGroup");
  assert.ok(/if \(bg\.autoH === false\) bg\.h = Math\.max\(Math\.round\(bg\.h \|\| 0\), needed\)/.test(body),
    "手动尺寸只保证够装");
  assert.ok(/else bg\.h = Math\.max\(300, needed\)/.test(body), "自动模式应按内容回缩（下限 300）");
  assert.ok(/autoH: true/.test(fnBody("createBigGroup")), "新建大组默认自动高度");
  const ev = fnBody("bindBigGroupEvents");
  assert.ok(/bg\.autoH = false/.test(ev.slice(ev.indexOf("big-group-resize") >= 0 ? 0 : 0)),
    "手动拖右下角后应关闭自动高度");
});

test("空分组被删除时会写入 localStorage（不留幽灵组）", () => {
  const body = fnBody("removeItem");
  assert.ok(/if \(groups\[gid\]\.length === 0\) delete groups\[gid\];\s*persistGroups\(\);/.test(body),
    "删空组后也应调用 persistGroups");
});

// ---------- 幻灯片 ----------

test("双击子区域或组内图片都按组放映", () => {
  const body = fnBody("bindBigGroupEvents");
  assert.ok(/big-group-sub[\s\S]{0,120}?openSlideshow\(sub\.dataset\.gid\)/.test(body),
    "双击子区域应放映该组");
  const card = JS_CODE.slice(JS_CODE.indexOf('el.addEventListener("dblclick"'));
  assert.ok(/bigGroupForGroup\(gid\)[\s\S]{0,40}?openSlideshow\(gid\)/.test(card),
    "双击大组内的图片应放映它所在的组");
});

test("放映按组内位置排序，且标题显示组序号", () => {
  const body = fnBody("openSlideshow");
  assert.ok(/getGroupItemObjects\(gid\)\.slice\(\)/.test(body), "应取该组的图片对象");
  assert.ok(/members\.sort\(\(a, b\) => \(a\.y - b\.y\) \|\| \(a\.x - b\.x\)\)/.test(body),
    "应按 y 再 x 排序");
  assert.ok(/组 \$\{idx >= 0 \? idx \+ 1 : 1\} · \$\{members\.length\} 张/.test(body),
    "标题应显示组序号与张数");
  assert.ok(/hidden = false/.test(body), "应打开幻灯片");
});

test("翻页边界禁用、计数器正确", () => {
  const body = fnBody("showSlide");
  assert.ok(/slideshowCounter\.textContent = `\$\{_slideIndex \+ 1\} \/ \$\{_slideItems\.length\}`/.test(body),
    "计数器应显示当前/总数");
  assert.ok(/slideshowPrev\.disabled = _slideIndex === 0/.test(body), "首张禁用上一张");
  assert.ok(/slideshowNext\.disabled = _slideIndex === _slideItems\.length - 1/.test(body),
    "末张禁用下一张");
});

test("快速切换用 token 丢弃过期加载结果", () => {
  const body = fnBody("showSlide");
  assert.ok(/const token = \+\+_slideLoadToken/.test(body), "每次加载应递增 token");
  assert.ok(/if \(token !== _slideLoadToken \|\| !url\) return/.test(body),
    "过期结果应被丢弃");
});

test("Esc 关闭、方向键翻页、遮罩点击关闭", () => {
  const body = fnBody("bindSlideshow");
  assert.ok(/e\.key === "Escape"[\s\S]{0,60}?closeSlideshow\(\)/.test(body), "Esc 应关闭");
  assert.ok(/e\.key === "ArrowLeft"[\s\S]{0,60}?showSlide\(_slideIndex - 1\)/.test(body),
    "← 应上一张");
  assert.ok(/e\.key === "ArrowRight"[\s\S]{0,60}?showSlide\(_slideIndex \+ 1\)/.test(body),
    "→ 应下一张");
  assert.ok(/slideshowBackdrop\.addEventListener\("click", closeSlideshow\)/.test(body),
    "遮罩点击应关闭");
});

test("放映中画布快捷键让位，关闭后清理", () => {
  const kb = fnBody("bindKeyboard");
  assert.ok(/if \(slideshowOpen\(\)\) return;/.test(kb), "放映中快捷键应直接返回");
  const close = fnBody("closeSlideshow");
  assert.ok(/hidden = true/.test(close), "关闭应隐藏");
  assert.ok(/_slideItems = \[\]/.test(close), "关闭应清空放映列表");
  assert.ok(/_slideLoadToken\+\+/.test(close), "关闭应让在途加载失效");
});

test("幻灯片样式：全屏覆盖且 hidden 时真正隐藏", () => {
  const block = cssBlock(".slide-show");
  assert.ok(/position:\s*fixed/.test(block), "幻灯片应固定覆盖");
  assert.ok(/\.slide-show\[hidden\]\s*\{\s*display:\s*none/.test(CSS_CODE), "hidden 时应 display:none");
  assert.ok(/z-index:\s*\d{3,}/.test(block), "幻灯片应盖在画布之上");
});

test("遮罩点击可关闭：头/舞台/脚不拦截点击，控件单独恢复", () => {
  assert.ok(/\.slide-head,\s*\.slide-stage,\s*\.slide-foot\s*\{\s*pointer-events:\s*none/.test(CSS_CODE),
    "三层容器应 pointer-events:none，否则会盖住 .slide-backdrop");
  assert.ok(/pointer-events:\s*auto/.test(cssBlock(".slide-close")), "关闭按钮应可点击");
  assert.ok(/pointer-events:\s*auto/.test(cssBlock(".slide-nav")), "翻页按钮应可点击");
  assert.ok(/pointer-events:\s*auto/.test(cssBlock(".slide-img")), "图片本身不触发关闭");
});

test("init 中完成幻灯片事件绑定", () => {
  const init = JS_CODE.slice(JS_CODE.indexOf("function init()"));
  assert.ok(/bindSlideshow\(\)/.test(init), "init 应调用 bindSlideshow");
});

// ---------- 输出 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) console.log(`  ${r.pass ? "✓" : `✗ ${r.err}`}  ${r.name}`);
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
