/* ═══════════════════════════════════════════════════ *
 *  图片墙模块（图片模式）
 *  桌面端走 invoke → Rust/SQLite；浏览器预览走 localStorage 兜底（base64 存图）。
 *  左侧：图片夹名称列表（新建/重命名/删除/切换）
 *  右侧：无限画布，图片以卡片形式自由摆放（拖拽/滚轮缩放/粘贴/拖文件上传）
 * ═══════════════════════════════════════════════════ */
import { invoke as invokeImpl } from "@tauri-apps/api/core";

const $ = id => document.getElementById(id);

function detectTauri() {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const t = window.__TAURI__;
  return !!(t && (t.core || t.invoke));
}
const isTauri = detectTauri;

async function mi(cmd, args) {
  if (isTauri()) {
    try { return await invokeImpl(cmd, args); }
    catch (e) { console.warn(`[图片墙] invoke("${cmd}") 失败:`, e); }
  }
  return null;
}

/* ---------- localStorage 兜底（浏览器预览：直接存 base64，简单可靠） ---------- */
const LS_FOLDERS = "glassCanvas.imageFolders";
const LS_ITEMS   = "glassCanvas.imageItems";
function lsLoad() { try { return JSON.parse(localStorage.getItem(LS_FOLDERS) || "[]"); } catch { return []; } }
function lsSave(a) { try { localStorage.setItem(LS_FOLDERS, JSON.stringify(a)); } catch {} }
function lsLoadItems() { try { return JSON.parse(localStorage.getItem(LS_ITEMS) || "[]"); } catch { return []; } }
function lsSaveItems(a) { try { localStorage.setItem(LS_ITEMS, JSON.stringify(a)); } catch {} }
let lsFolders  = lsLoad();
let lsItems    = lsLoadItems();
let _lsIdSeq   = 0;

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ? s : "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function nowTs() { return Date.now(); }
function uid() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ---------- toast 反馈 ----------
 * 与 main.js 的 toast 函数保持同一套 DOM 节点（#app-toast），
 * 让上传/删除/恢复等关键操作的成败对用户可见，而不是仅靠 console.warn。 */
let _toastTimer = null;
function toast(msg, ms) {
  let t = document.getElementById("app-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "app-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), ms || 3000);
}

/* ---------- 图片夹顺序（localStorage，与任务夹同样的 orderMap 模式） ----------
 * 之前 list_image_folders 只按 created_at ASC 排序，没有任何重排能力，
 * 用户拖动时完全无反应。这里和 main.js 的 getFolderOrderMap 保持一致的
 * 模式：把拖拽后的视觉顺序写到 localStorage，renderFolderList 时据此排序。 */
const IMAGE_FOLDER_ORDER_KEY = "glassCanvas.imageFolderOrder";
function getImageFolderOrderMap() {
  try { return JSON.parse(localStorage.getItem(IMAGE_FOLDER_ORDER_KEY) || "{}"); }
  catch { return {}; }
}
function saveImageFolderOrderMap(map) {
  try { localStorage.setItem(IMAGE_FOLDER_ORDER_KEY, JSON.stringify(map)); } catch {}
}
function applyImageFolderOrder(list) {
  const m = getImageFolderOrderMap();
  const keys = Object.keys(m);
  // 没有 orderMap 信息时保持后端返回的原始顺序（created_at ASC）
  if (!keys.length) return list;
  return list.slice().sort((a, b) => {
    const oa = m[String(a.id)];
    const ob = m[String(b.id)];
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    if (oa !== ob) return oa - ob;
    return 0; // 相等时保留数组原顺序（stable sort）
  });
}

/* ---------- DOM 引用 ---------- */
const confirmModal    = $("confirm-modal");
const confirmTitle    = $("confirm-title");
const confirmMsgEl    = $("confirm-msg");
const confirmOkBtn    = $("confirm-ok");
const newImageFolderBtn = $("new-image-folder-btn");
const imageFolderListEl = $("image-folder-list");
const imagePane       = $("mode-pane-images");
const imageCanvas     = $("image-canvas");
const imageWorld      = $("image-world");
const imageEmpty      = $("image-empty");
const imageTitleEl    = $("image-title");
const imageMetaEl     = $("image-meta");
const imageToolbar    = $("image-toolbar");
const imageAddBtn     = $("image-add");
const imageZoomOutBtn = $("image-zoom-out");
const imageZoomInBtn  = $("image-zoom-in");
const imageZoomLabel  = $("image-zoom-label");
const imageFitBtn     = $("image-fit");
const imageFileInput  = $("image-file-input");

/* ---------- 状态 ---------- */
let folders = [];
let activeFolderId = null;
let activeFolder = null;
let items = [];          // 当前夹的图片记录
let view = { x: 40, y: 40, zoom: 1 };
const itemEls = new Map(); // itemId -> DOM el
let selection = new Set(); // 选中的 itemId
let zTop = 100;
let drag = null;          // 拖拽/平移会话
let _viewTimer = null;
let _itemSaveTimers = new Map(); // itemId -> 保存防抖定时器
let _renaming = false;

/* ---------- 应用内确认弹窗（复用 mindmap.js 的 confirm-modal） ---------- */
let _confirmResolve = null;
function askConfirm(message, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    confirmTitle.textContent = o.title || "确认操作";
    confirmMsgEl.innerHTML = message;
    confirmOkBtn.textContent = o.okText || "确认";
    _confirmResolve = resolve;
    // 同步挂到全局，让 mindmap.js 的 closeConfirm 能 resolve 本弹窗
    window.__confirmResolve = resolve;
    confirmModal.hidden = false;
  });
}

/* ---------- API ---------- */
async function apiListFolders() {
  const r = await mi("list_image_folders");
  if (r) return r;
  return lsFolders.slice();
}
async function apiCreateFolder(name) {
  const r = await mi("create_image_folder", { name });
  if (r) return r;
  const id = (_lsIdSeq--);
  const f = { id, name: (name && name.trim()) || "未命名图片夹", created_at: nowTs(), total: 0, pan_x: 40, pan_y: 40, zoom: 1 };
  lsFolders.push(f); lsSave(lsFolders);
  return f;
}
async function apiRenameFolder(id, name) {
  if (isTauri()) await mi("rename_image_folder", { id, name });
  const nm = name || "未命名图片夹";
  const f = folders.find(x => x.id === id); if (f) f.name = nm;
  const lf = lsFolders.find(x => x.id === id); if (lf) { lf.name = nm; lsSave(lsFolders); }
}
async function apiDeleteFolder(id) {
  if (isTauri()) await mi("delete_image_folder", { id });
  lsFolders = lsFolders.filter(x => x.id !== id); lsSave(lsFolders);
  lsItems = lsItems.filter(x => x.folder_id !== id); lsSaveItems(lsItems);
  if (activeFolderId === id) {
    activeFolderId = null; activeFolder = null;
    items = [];
    selection.clear();
  }
}
async function apiSaveFolderView(id, pan_x, pan_y, zoom) {
  if (isTauri()) await mi("update_image_folder_view", { id, pan_x, pan_y, zoom });
  const f = folders.find(x => x.id === id); if (f) { f.pan_x = pan_x; f.pan_y = pan_y; f.zoom = zoom; }
  const lf = lsFolders.find(x => x.id === id); if (lf) { lf.pan_x = pan_x; lf.pan_y = pan_y; lf.zoom = zoom; lsSave(lsFolders); }
}
async function apiListItems(folderId) {
  const r = await mi("list_image_items", { folder_id: folderId });
  if (r) return r;
  return lsItems.filter(x => x.folder_id === folderId);
}
function bytesToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}
async function apiSaveImage(folderId, fileName, title, data) {
  if (isTauri()) {
    return await mi("save_image", {
      folder_id: folderId,
      file_name: fileName,
      title,
      data: Array.from(data, b => b & 0xff),
    });
  }
  const id = (_lsIdSeq--);
  const item = { id, folder_id: folderId, file_name: fileName, file_path: `${folderId}/${fileName}`, title, x: 0, y: 0, width: 0, height: 0, created_at: nowTs() };
  lsItems.push(item); lsSaveItems(lsItems);
  // 浏览器兜底：把原始字节转 base64 后存进 localStorage
  const mime = guessMime(fileName);
  try {
    const dataURL = `data:${mime};base64,` + bytesToBase64(data);
    localStorage.setItem(`glassCanvas.img.${folderId}.${fileName}`, dataURL);
  } catch (e) {
    console.warn("[图片墙] localStorage 保存失败（可能超出配额）:", e);
  }
  return item;
}
async function apiUpdateItem(id, x, y, width, height, title) {
  if (isTauri()) {
    await mi("update_image_item", { id, x, y, width, height, title });
  }
  const it = lsItems.find(x => x.id === id);
  if (it) { it.x = x; it.y = y; it.width = width; it.height = height; it.title = title; lsSaveItems(lsItems); }
}
async function apiDeleteItem(id) {
  if (isTauri()) {
    await mi("delete_image_item", { id });
  }
  const it = lsItems.find(x => x.id === id);
  if (it) {
    try { localStorage.removeItem(`glassCanvas.img.${it.folder_id}.${it.file_name}`); } catch {}
    lsItems = lsItems.filter(x => x.id !== id); lsSaveItems(lsItems);
  }
}
async function apiReadImageFile(folderId, filePath) {
  if (isTauri()) {
    const bytes = await mi("read_image_file", { folder_id: folderId, file_path: filePath });
    if (!bytes) return null;
    const u8 = new Uint8Array(bytes);
    const mime = guessMime(filePath);
    return URL.createObjectURL(new Blob([u8], { type: mime }));
  }
  // 浏览器兜底：直接读回 dataURL
  try {
    const key = `glassCanvas.img.${folderId}.${filePath.split("/").pop()}`;
    return localStorage.getItem(key) || null;
  } catch { return null; }
}
function guessMime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" }[ext]) || "application/octet-stream";
}

/* ---------- 视图应用（平移/缩放） ---------- */
function applyView() {
  if (!imageWorld) return;
  imageWorld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  if (imageZoomLabel) imageZoomLabel.textContent = Math.round(view.zoom * 100) + "%";
}
function saveViewSoon() {
  if (!activeFolder) return;
  if (_viewTimer) clearTimeout(_viewTimer);
  _viewTimer = setTimeout(() => apiSaveFolderView(activeFolder.id, view.x, view.y, view.zoom), 400);
}
function zoomAt(cx, cy, factor) {
  const z0 = view.zoom;
  const z1 = clamp(z0 * factor, 0.15, 4);
  if (z1 === z0) return;
  view.x = cx - (cx - view.x) * (z1 / z0);
  view.y = cy - (cy - view.y) * (z1 / z0);
  view.zoom = z1;
  applyView();
  saveViewSoon();
}
function toWorld(clientX, clientY) {
  const r = imageCanvas.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
}
function fitView() {
  if (!items.length) { view = { x: 40, y: 40, zoom: 1 }; applyView(); saveViewSoon(); return; }
  const r = imageCanvas.getBoundingClientRect();
  const pad = 60;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + (it.width || 200));
    maxY = Math.max(maxY, it.y + (it.height || 200));
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const z = clamp(Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh), 0.15, 2);
  view.zoom = z;
  view.x = (r.width - bw * z) / 2 - minX * z;
  view.y = (r.height - bh * z) / 2 - minY * z;
  applyView(); saveViewSoon();
}

/* ---------- 卡片渲染 ---------- */
const CARD_DEFAULT_W = 220;
function renderItems() {
  if (!imageWorld) return;
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    let el = itemEls.get(it.id);
    if (!el) {
      el = createCardEl(it);
      itemEls.set(it.id, el);
      imageWorld.appendChild(el);
    }
    el.style.left = it.x + "px";
    el.style.top = it.y + "px";
    el.style.width = (it.width || CARD_DEFAULT_W) + "px";
    el.style.zIndex = it.z || zTop++;
    el.classList.toggle("selected", selection.has(it.id));
  }
  for (const [id, el] of itemEls) {
    if (!seen.has(id)) { el.remove(); itemEls.delete(id); }
  }
  updateEmpty();
  updateHeader();
}
function createCardEl(it) {
  const el = document.createElement("div");
  el.className = "img-card";
  el.dataset.id = String(it.id);
  el.style.zIndex = it.z || (++zTop);
  el.innerHTML = `
    <div class="card-img-wrap">
      <img class="card-img" alt="" draggable="false" />
    </div>
    <div class="card-caption" title="双击编辑标题">${esc(it.title) || "（无标题）"}</div>
    <div class="card-tools">
      <button class="tool-btn" data-act="copy" title="复制">⧉</button>
      <button class="tool-btn" data-act="top" title="置顶">⤒</button>
      <button class="tool-btn" data-act="rm" title="删除">✕</button>
    </div>
    <span class="resize-handle" data-dir="se" title="拖动调整大小"></span>
    <span class="resize-handle" data-dir="e" title="拖动调整宽度"></span>
    <span class="resize-handle" data-dir="s" title="拖动调整高度"></span>
  `;
  const img = el.querySelector(".card-img");
  if (it.width && it.height) {
    el.style.aspectRatio = `${it.width} / ${it.height}`;
  }
  loadImageFor(it, img);
  bindCardEvents(el, it);
  return el;
}

async function loadImageFor(it, imgEl) {
  if (!imgEl) return;
  if (imgEl.src && imgEl.dataset.loaded === "1") return;
  try {
    const url = await apiReadImageFile(it.folder_id ?? activeFolderId, it.file_path);
    if (!url) return;
    imgEl.src = url;
    imgEl.dataset.loaded = "1";
  } catch (e) {
    console.warn("[图片墙] 加载图片失败:", e);
  }
}

function bindCardEvents(el, it) {
  el.addEventListener("mousedown", e => {
    // 缩放手柄 → 独立 resize 逻辑
    if (e.target.closest(".resize-handle")) { startResize(e, it, el); return; }
    // 卡片工具按钮 → 由按钮自己的 click 事件处理，不启动拖拽
    if (e.target.closest(".card-tools")) return;
    // 标题栏：仅选中，不启动拖拽（保留双击重命名体验）
    if (e.target.closest(".card-caption")) {
      e.stopPropagation();
      bringToFront(it);
      selectItem(it.id, e.ctrlKey || e.metaKey);
      return;
    }
    // 其余区域（图片）：选中 + 启动拖拽
    e.preventDefault();
    e.stopPropagation();
    bringToFront(it);
    selectItem(it.id, e.ctrlKey || e.metaKey);
    startCardDrag(e, it, el);
  });
  el.addEventListener("dblclick", e => {
    if (e.target.closest(".card-caption")) { startRenameCaption(e, it, el); return; }
    if (e.target.closest(".card-img-wrap") || e.target.closest("img")) {
      // 双击图片本身：放大预览？这里保持简单，仅编辑标题
      startRenameCaption(e, it, el);
    }
  });
  el.querySelector(".card-tools").addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === "copy") cloneItem(it);
    else if (act === "top") bringToFront(it);
    else if (act === "rm") removeItem(it.id);
  });
}

function selectItem(id, additive) {
  if (additive) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
  } else {
    selection.clear();
    selection.add(id);
  }
  for (const [iid, el] of itemEls) el.classList.toggle("selected", selection.has(iid));
}
function bringToFront(it) {
  it.z = ++zTop;
  const el = itemEls.get(it.id);
  if (el) el.style.zIndex = it.z;
  debouncedSaveItem(it.id);
}
function debouncedSaveItem(id) {
  if (_itemSaveTimers.has(id)) clearTimeout(_itemSaveTimers.get(id));
  _itemSaveTimers.set(id, setTimeout(() => {
    const it = items.find(x => x.id === id);
    if (!it) return;
    apiUpdateItem(it.id, it.x, it.y, it.width || CARD_DEFAULT_W, it.height || 0, it.title);
    _itemSaveTimers.delete(id);
  }, 350));
}

/* ---------- 拖拽：卡片移动 ---------- */
function startCardDrag(e, it, el) {
  const start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y };
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / view.zoom;
    const dy = (ev.clientY - start.y) / view.zoom;
    it.x = start.ix + dx;
    it.y = start.iy + dy;
    el.style.left = it.x + "px";
    el.style.top = it.y + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    debouncedSaveItem(it.id);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

/* ---------- 拖拽：缩放 ---------- */
function startResize(e, it, el) {
  const dir = e.target.dataset.dir;
  const sx = e.clientX, sy = e.clientY;
  const w0 = it.width || CARD_DEFAULT_W;
  const h0 = it.height || el.offsetHeight;
  const move = (ev) => {
    const dx = (ev.clientX - sx) / view.zoom;
    const dy = (ev.clientY - sy) / view.zoom;
    if (dir === "se" || dir === "e") it.width = Math.max(80, w0 + dx);
    if (dir === "se" || dir === "s") it.height = Math.max(80, h0 + dy);
    el.style.width = it.width + "px";
    el.style.height = it.height + "px";
    el.style.aspectRatio = it.height > 0 ? `${it.width} / ${it.height}` : "auto";
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    debouncedSaveItem(it.id);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  e.preventDefault();
  e.stopPropagation();
}

/* ---------- 卡片标题编辑 ---------- */
function startRenameCaption(e, it, el) {
  e.stopPropagation();
  const cap = el.querySelector(".card-caption");
  const old = it.title || "";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = old;
  input.className = "caption-input";
  cap.innerHTML = "";
  cap.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (commit && val !== old) {
      it.title = val;
      debouncedSaveItem(it.id);
    }
    cap.textContent = it.title || "（无标题）";
    cap.title = "双击编辑标题";
  };
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    ev.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", ev => ev.stopPropagation());
}

/* ---------- 卡片复制/删除 ---------- */
async function cloneItem(it) {
  if (!activeFolder) return;
  // 复制图片文件（读回字节 → 生成新名 → 存新记录）
  let newItem = null;
  try {
    let bytes = null;
    if (isTauri()) {
      const bytesRaw = await mi("read_image_file", { folder_id: activeFolder.id, file_path: it.file_path });
      if (bytesRaw) bytes = new Uint8Array(bytesRaw);
    } else {
      const key = `glassCanvas.img.${activeFolder.id}.${it.file_name}`;
      const dataURL = localStorage.getItem(key);
      if (dataURL) {
        const b64 = dataURL.split(",")[1];
        bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      }
    }
    if (!bytes) return;
    const ext = (it.file_name.split(".").pop() || "png").toLowerCase();
    const newFileName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    newItem = await apiSaveImage(activeFolder.id, newFileName, it.title + " 副本", bytes);
    if (!newItem) return;
    newItem.x = it.x + 24;
    newItem.y = it.y + 24;
    newItem.width = it.width; newItem.height = it.height;
    newItem.z = ++zTop;
    items.push(newItem);
    debouncedSaveItem(newItem.id);
    renderItems();
  } catch (err) {
    console.warn("[图片墙] 复制图片失败:", err);
  }
}
async function removeItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  const ok = await askConfirm(
    `确定删除「${esc(it.title || "该图片")}」？删除后不可恢复。`,
    { title: "删除图片", okText: "删除" }
  );
  if (!ok) return;
  try {
    await apiDeleteItem(id);
  } catch (err) {
    console.error("[图片墙] 删除图片失败:", err);
    toast("删除失败：" + (err.message || String(err)).slice(0, 60));
    return;
  }
  items = items.filter(x => x.id !== id);
  selection.delete(id);
  const el = itemEls.get(id);
  if (el) { el.remove(); itemEls.delete(id); }
  // 同步侧栏计数（之前漏了这一步，删完图片侧栏数字一直不变）
  const fld = folders.find(x => x.id === activeFolderId);
  if (fld) fld.total = Math.max(0, (fld.total || 0) - 1);
  renderFolderList();
  updateEmpty();
  updateHeader();
  toast("已删除");
}

/* ---------- 图片上传 ---------- */
async function uploadFile(file) {
  if (!activeFolder) {
    // 没有激活的图片夹时，先建一个再上传（保持用户体验：直接拖文件进去也能用）
    const f = await apiCreateFolder("图片夹 " + (folders.length + 1));
    folders.push(f);
    await setActiveFolder(f.id);
  }
  if (!file || !/^image\//.test(file.type || "")) {
    // 有些截图粘贴 mime 可能是空
    if (!file || (file.type && !file.type.startsWith("image"))) return;
  }
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const ext = (file.name.split(".").pop() || (file.type.split("/")[1] || "png")).replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const title = (file.name.replace(/\.[^.]+$/, "") || "").trim() || "图片";
    const it = await apiSaveImage(activeFolder.id, fileName, title, bytes);
    if (!it) { toast("上传失败：未返回图片信息", 3500); return; }
    // 拿到宽高用于初始布局
    const dim = await probeImageSize(bytes, file.type || guessMime(fileName));
    // 放置在画布中心
    const r = imageCanvas.getBoundingClientRect();
    const cx = (r.width / 2 - view.x) / view.zoom;
    const cy = (r.height / 2 - view.y) / view.zoom;
    const w = dim.w && dim.w > 0 ? Math.min(dim.w, 480) : CARD_DEFAULT_W;
    const scale = dim.h && dim.w ? Math.min(1, 480 / dim.w) : 1;
    const h = dim.h ? dim.h * scale : w;
    it.x = cx - w / 2;
    it.y = cy - h / 2;
    it.width = w;
    it.height = h;
    it.z = ++zTop;
    items.push(it);
    debouncedSaveItem(it.id);
    renderItems();
    // 同步侧栏计数（之前只 renderFolderList 但 folders[].total 没更新，数字一直不变）
    const fld = folders.find(x => x.id === activeFolder.id);
    if (fld) fld.total = (fld.total || 0) + 1;
    renderFolderList();
    toast(`已添加「${title.slice(0, 16)}」`);
  } catch (e) {
    console.warn("[图片墙] 上传失败:", e);
    toast("上传失败：" + (e.message || String(e)).slice(0, 60));
  }
}
function probeImageSize(bytes, mime) {
  return new Promise(resolve => {
    const blob = new Blob([bytes], { type: mime || "image/png" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/* ---------- 空状态 ---------- */
function updateEmpty() {
  if (!imageEmpty) return;
  imageEmpty.hidden = items.length > 0;
}
function updateHeader() {
  if (imageTitleEl) imageTitleEl.textContent = activeFolder ? activeFolder.name : "图片墙";
  if (imageMetaEl) imageMetaEl.textContent = activeFolder ? `${items.length} 张` : "";
  if (imageToolbar) imageToolbar.hidden = !activeFolder;
}

/* ---------- 图片夹列表 ---------- */
async function renderFolderList() {
  if (!imageFolderListEl) return;
  imageFolderListEl.innerHTML = "";
  // 拖拽顺序在本地（orderMap），后端只负责存夹本身
  const ordered = applyImageFolderOrder(folders);
  for (const f of ordered) {
    const li = document.createElement("li");
    li.className = "folder-item";
    if (f.id === activeFolderId) li.classList.add("active");
    li.dataset.id = String(f.id);
    li.innerHTML = `
      <span class="name">${esc(f.name)}</span>
      <span class="cnt">${f.total ?? 0}</span>
      <button class="rm" title="删除" aria-label="删除图片夹">✕</button>
    `;
    li.addEventListener("click", e => {
      if (e.target.closest(".rm")) { e.stopPropagation(); return; }
      setActiveFolder(f.id);
    });
    li.addEventListener("dblclick", e => {
      if (e.target.closest(".rm")) return;
      startRenameFolder(li, f);
    });
    // 指针拖动重排：拖整个 li 即可（与任务夹一致）
    li.addEventListener("pointerdown", e => startImageFolderDrag(e, f.id, li));
    li.querySelector(".rm").addEventListener("click", async e => {
      e.stopPropagation();
      const ok = await askConfirm(
        `确定删除「${esc(f.name)}」？<br/>其中的 <b>${f.total ?? 0}</b> 张图片也会被一并删除，此操作不可恢复。`,
        { title: "删除图片夹", okText: "删除" }
      );
      if (!ok) return;
      try {
        await apiDeleteFolder(f.id);
        folders = folders.filter(x => x.id !== f.id);
        await loadFolders(true);
        toast(`已删除「${f.name}」`);
      } catch (err) {
        console.error("[图片墙] 删除图片夹失败:", err);
        toast("删除失败：" + (err.message || String(err)).slice(0, 60));
      }
    });
    imageFolderListEl.appendChild(li);
  }
}

/* ---------- 图片夹拖动重排 ----------
 * 复用与 main.js startFolderPointerDrag 完全一致的 pointer 拖拽模式：
 * pointerdown + setPointerCapture + window pointermove/pointerup。
 * HTML5 DnD 在 WebView2 打包后侧栏 li 作为拖源不稳定，pointer 模式跨夹移动那块
 * 已经验证可用，这里沿用同一套交互。
 *
 * 交互细节：
 * - 拖动前 4px 阈值内不当拖动，仅当 pointermove 超过阈值才激活拖拽视觉；
 * - 移动时用 elementFromPoint 命中最近的 .folder-item，按鼠标相对中线挂
 *   fold-drop-before / fold-drop-after class 显示插入指示线；
 * - 松手时按当前 hover 目标调用 reorderImageFolders(srcId, targetId)。 */
function startImageFolderDrag(e, srcId, srcEl) {
  // 删除按钮、重命名输入框上不启动拖动
  if (e.target.closest(".rm")) return;
  if (e.target.closest("input")) return;
  if (e.button != null && e.button !== 0) return;
  // 已经在拖动另一个夹
  if (_imgFoldDragSrc != null) return;

  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  let activated = false;
  let lastX = startX, lastY = startY;

  try { srcEl.setPointerCapture(e.pointerId); } catch (_) {}

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!activated) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      activated = true;
      _imgFoldDragSrc = srcId;
      _imgFoldDragSrcEl = srcEl;
      srcEl.classList.add("fold-dragging");
      imageFolderListEl.classList.add("reordering");
    }
    ev.preventDefault();
    lastX = ev.clientX; lastY = ev.clientY;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    imageFolderListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    if (!tgt || Number(tgt.dataset.id) === Number(srcId)) return;
    const r = tgt.getBoundingClientRect();
    const isVertical = getComputedStyle(imageFolderListEl).flexDirection !== "row";
    const pastMid = isVertical
      ? (ev.clientY > r.top + r.height / 2)
      : (ev.clientX > r.left + r.width / 2);
    tgt.classList.add(pastMid ? "fold-drop-after" : "fold-drop-before");
  };

  const onUp = (ev) => {
    try { srcEl.releasePointerCapture(e.pointerId); } catch (_) {}
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = activated && el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    const tgtId = tgt ? Number(tgt.dataset.id) : null;
    srcEl.classList.remove("fold-dragging");
    imageFolderListEl.classList.remove("reordering");
    imageFolderListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    const wasDragging = activated;
    const dragSrc = _imgFoldDragSrc;
    _imgFoldDragSrc = null; _imgFoldDragSrcEl = null;
    if (wasDragging) {
      // 用 _imgFoldDragLastX/Y 记录落点，让 reorderImageFolders 判断 before/after
      _imgFoldDragLastX = lastX;
      _imgFoldDragLastY = lastY;
      if (tgtId != null && tgtId !== Number(dragSrc)) reorderImageFolders(dragSrc, tgtId);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
let _imgFoldDragSrc = null;
let _imgFoldDragSrcEl = null;
let _imgFoldDragLastX = 0;
let _imgFoldDragLastY = 0;

/* 拖动图片夹到目标位置：把源元素插到目标之前/之后。
 * 与任务夹 reorderFolders 一致：
 * 1) 从当前 DOM 读取可见顺序（DOM 就是 renderFolderList 刚渲染出来的，最权威）；
 * 2) 按视觉顺序重排 orderMap，让 index 0..n-1 连续；
 * 3) 不再动 folders 数组（它是后端原始顺序，不动它更安全）。 */
function reorderImageFolders(srcId, targetId) {
  // 用 DOM 中的当前顺序作为基准（含已排序的视觉顺序）
  const items = Array.from(imageFolderListEl.querySelectorAll(".folder-item"))
    .map(li => Number(li.dataset.id));
  const srcIdx = items.indexOf(srcId);
  const tgtIdx = items.indexOf(targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;

  // 判断落点在目标上方还是下方
  const tgtEl = imageFolderListEl.querySelector(`li[data-id="${targetId}"]`);
  let pastMid = false;
  if (tgtEl) {
    const r = tgtEl.getBoundingClientRect();
    const isVertical = getComputedStyle(imageFolderListEl).flexDirection !== "row";
    pastMid = isVertical
      ? (_imgFoldDragLastY > r.top + r.height / 2)
      : (_imgFoldDragLastX > r.left + r.width / 2);
  }

  // 从 items 移除源
  items.splice(srcIdx, 1);
  // 重新定位目标在新数组中的下标（因为移除后可能左移）
  let insertAt = items.indexOf(targetId);
  if (insertAt < 0) return;
  if (pastMid) insertAt += 1;
  items.splice(insertAt, 0, srcId);

  // 写回 orderMap：让 index 从 0 连续递增
  const map = {};
  items.forEach((id, i) => { map[String(id)] = i; });
  saveImageFolderOrderMap(map);
  renderFolderList();
}
let _renamingFolderId = null;
function startRenameFolder(li, f) {
  if (_renamingFolderId !== null) return;
  _renamingFolderId = f.id;
  const old = f.name;
  const span = li.querySelector(".name");
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 30;
  input.value = old;
  input.className = "map-rename-input";
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    _renamingFolderId = null;
    const val = input.value.trim();
    if (commit && val && val !== old) {
      await apiRenameFolder(f.id, val);
      await renderFolderList();
    } else {
      await renderFolderList();
    }
  };
  input.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    else if (ev.key === "Escape") { ev.preventDefault(); input.blur(); }
  });
  input.addEventListener("blur", () => finish(true));
}

async function loadFolders(keepActive) {
  folders = await apiListFolders();
  if (!keepActive || !activeFolderId || !folders.some(x => x.id === activeFolderId)) {
    // 首次或原夹被删除：自动打开第一个
    activeFolderId = null; activeFolder = null;
    items = [];
    for (const [, el] of itemEls) el.remove();
    itemEls.clear();
    selection.clear();
    view = { x: 40, y: 40, zoom: 1 };
    if (folders.length) {
      await setActiveFolder(folders[0].id);
      return;
    }
  }
  applyView();
  renderFolderList();
  updateEmpty();
  updateHeader();
  renderItems();
}

async function setActiveFolder(id) {
  // 保存旧夹的视图
  if (activeFolder && activeFolder.id !== id) {
    await apiSaveFolderView(activeFolder.id, view.x, view.y, view.zoom);
  }
  activeFolderId = id;
  const f = folders.find(x => x.id === id);
  activeFolder = f || null;
  if (f) {
    view = { x: f.pan_x ?? 40, y: f.pan_y ?? 40, zoom: f.zoom || 1 };
  } else {
    view = { x: 40, y: 40, zoom: 1 };
  }
  items = await apiListItems(id);
  // 清理旧卡片 DOM
  for (const [, el] of itemEls) el.remove();
  itemEls.clear();
  selection.clear();
  applyView();
  renderFolderList();
  renderItems();
}

/* ---------- 画布事件：平移 / 缩放 / 双击上传 ---------- */
function bindCanvasEvents() {
  imageCanvas.addEventListener("mousedown", e => {
    if (e.target !== imageCanvas && e.target !== imageWorld) return;
    if (e.button !== 0) return;
    // 空处点击：清空选择
    selection.clear();
    for (const [, el] of itemEls) el.classList.remove("selected");
    // 平移
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    imageCanvas.classList.add("panning");
    const move = (ev) => {
      view.x = start.vx + (ev.clientX - start.x);
      view.y = start.vy + (ev.clientY - start.y);
      applyView();
    };
    const up = () => {
      imageCanvas.classList.remove("panning");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      saveViewSoon();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  imageCanvas.addEventListener("wheel", e => {
    if (!activeFolder) return;
    e.preventDefault();
    const r = imageCanvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(cx, cy, factor);
  }, { passive: false });

  imageCanvas.addEventListener("dblclick", e => {
    if (e.target !== imageCanvas && e.target !== imageWorld) return;
    // 之前写错了：没有夹时只点了"新建夹"按钮，弹文件框的步骤根本没做，
    // 用户双击空白后只多出一个空夹、没有任何上传动作（这是"图片无法上传"的根因之一）。
    // 正确做法：直接弹文件选择；选完走 imageFileInput change → uploadFile 自动建夹。
    imageFileInput.click();
  });

  // 拖文件到画布
  imageCanvas.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    imageCanvas.classList.add("drop-hover");
  });
  imageCanvas.addEventListener("dragleave", e => {
    if (e.target !== imageCanvas) return;
    imageCanvas.classList.remove("drop-hover");
  });
  imageCanvas.addEventListener("drop", async e => {
    e.preventDefault();
    imageCanvas.classList.remove("drop-hover");
    const files = Array.from(e.dataTransfer.files || []).filter(f => /^image\//.test(f.type));
    if (!files.length) return;
    // uploadFile 内部会在没有激活夹时自动创建夹，所以这里直接遍历上传即可
    for (const f of files) await uploadFile(f);
  });

  imageFileInput.addEventListener("change", async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    for (const f of files) await uploadFile(f);
  });

  // Ctrl+V 粘贴
  document.addEventListener("paste", async e => {
    // 仅在图片模式且有画布可见时响应
    if (!imagePane || imagePane.hidden) return;
    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
    if (_renaming) return;
    const items2 = e.clipboardData?.items || [];
    const imgs = [];
    for (const it of items2) {
      if (it.type && it.type.startsWith("image")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (!imgs.length) return;
    e.preventDefault();
    for (const f of imgs) await uploadFile(f);
  });
}

async function newFolderAndUpload(files) {
  // 保留作为兼容路径：极少数地方（外部入口）可能直接调用。
  // 实际上传走 uploadFile，它会处理"没有激活夹"的情况。
  if (!files || !files.length) return;
  if (!activeFolder) {
    const f = await apiCreateFolder("图片夹 " + (folders.length + 1));
    folders.push(f);
    await setActiveFolder(f.id);
  }
  for (const file of files) await uploadFile(file);
}

/* ---------- 工具栏 ---------- */
function bindToolbar() {
  if (imageAddBtn) imageAddBtn.addEventListener("click", () => {
    // 之前这里写错了：没有夹时调 newImageFolderBtn.click() 只创建空夹，
    // 用户选中的文件根本没机会被上传（点上传按钮后没反应就是这个 bug）。
    // 正确做法：直接弹文件选择框；用户选了文件再走 uploadFile，
    // uploadFile 内部会在没有夹时自动创建夹。
    imageFileInput.click();
  });
  if (imageZoomInBtn) imageZoomInBtn.addEventListener("click", () => {
    if (!imageCanvas) return;
    const r = imageCanvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.2);
  });
  if (imageZoomOutBtn) imageZoomOutBtn.addEventListener("click", () => {
    if (!imageCanvas) return;
    const r = imageCanvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
  });
  if (imageFitBtn) imageFitBtn.addEventListener("click", () => fitView());
}

/* ---------- 键盘：Delete 删除选中 ---------- */
function bindKeyboard() {
  document.addEventListener("keydown", async e => {
    if (!imagePane || imagePane.hidden) return;
    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
    if (_renaming) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selection.size) {
      e.preventDefault();
      for (const id of [...selection]) await removeItem(id);
    }
  });
}

/* ---------- 初始化 ---------- */
function bindNewFolderBtn() {
  newImageFolderBtn.addEventListener("click", async () => {
    // 点击立即创建（用默认名），然后进入重命名输入框。
    // 这样和任务夹/思维导图"新建即改名"的体验一致，也不会因用户取消输入而卡死。
    const f = await apiCreateFolder("");
    folders.push(f);
    await setActiveFolder(f.id);
    await renderFolderList();
    const li = imageFolderListEl.querySelector(`li[data-id="${f.id}"]`);
    if (li) startRenameFolder(li, f);
  });
}
function askInput(title, placeholder) {
  // 自定义弹窗，避免与 main.js 的 modal 事件冲突（main.js 的 modal-ok 会创建任务夹）。
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay prompt-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3 class="prompt-title">${esc(title)}</h3>
      <input class="prompt-input" type="text" maxlength="30" autocomplete="off" />
      <div class="modal-actions">
        <button class="prompt-cancel">取消</button>
        <button class="primary prompt-ok">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector(".prompt-input");
  const okBtn = overlay.querySelector(".prompt-ok");
  const cancelBtn = overlay.querySelector(".prompt-cancel");
  input.placeholder = placeholder;
  input.value = "";
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      overlay.remove();
      resolve(v);
    };
    okBtn.addEventListener("click", () => finish(input.value.trim() || null));
    cancelBtn.addEventListener("click", () => finish(null));
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(input.value.trim() || null); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
    });
    overlay.addEventListener("click", e => { if (e.target === overlay) finish(null); });
  });
}

function init() {
  bindCanvasEvents();
  bindToolbar();
  bindKeyboard();
  bindNewFolderBtn();
  // 暴露给 mindmap.js 的 setMode 钩子
  window.__loadImageWall = () => loadFolders(true);
  // 初始加载一次（如果图片 tab 一开始就是 active 会显示）
  loadFolders(true);
}
init();
