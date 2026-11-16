// ==UserScript==
// @name         S1 发送前关键词零宽处理
// @namespace    local.s1.keyword-zwnj
// @version      1.0.1
// @homepageURL  https://github.com/mirari/s1-userscript
// @updateURL    https://raw.githubusercontent.com/mirari/s1-userscript/main/s1-keyword-zwnj.user.js
// @downloadURL  https://raw.githubusercontent.com/mirari/s1-userscript/main/s1-keyword-zwnj.user.js
// @description  纯离线修正自定义普通表达误伤，不接入敏感词库
// @match        *://*.saraba1st.com/*
// @match        *://*.stage1st.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(() => {
'use strict';
const Z = '\u200c';
const FIELD = 'textarea[name="message"],textarea#fastpostmessage,textarea#postmessage,textarea#e_textarea,input[name="subject"]';
const SEND = '#postsubmit,#fastpostsubmit,#pmsubmit,button[type="submit"],input[type="submit"],button:not([type])';
// No bundled words. Previously saved user settings remain local.
function normalizeWords(text) {
 return [...new Set(String(text ?? '').split(/\r?\n/).map(w => w.replaceAll(Z, '').trim()).filter(w => Array.from(w).length > 1))].join('\n');
}
const saved = GM_getValue('accidental-phrases-v3', {enabled:true, words:''});
let config = {enabled:saved?.enabled !== false, words:normalizeWords(saved?.words)};
let revision = 0, busy = false, replay = null;
let local = makeLocal(config.words);
function makeLocal(words) {
 const list = normalizeWords(words).split('\n').filter(Boolean);
 // Mark all overlapping matches; metacharacters remain literal.
 return text => {
  const raw = Array.from(text), chars = [], pos = [];
  raw.forEach((ch,i) => { if (ch !== Z) { chars.push(ch); pos.push(i); } });
  const marks = new Set();
  for (const word of list) {
   const w = Array.from(word);
   for (let i = 0; i <= chars.length - w.length; i++) {
    if (w.every((ch,j) => ch === chars[i+j])) for (let j = i; j < i+w.length-1; j++) marks.add(pos[j]);
   }
  }
  return raw.map((ch,i) => ch + (marks.has(i) && raw[i+1] !== Z ? Z : '')).join('');
 };
}
function visible(element) { return element.getClientRects().length > 0; }
function collect(root) {
 const items = [];
 const frames = [...root.querySelectorAll('iframe#e_iframe')].filter(visible);
 for (const field of root.querySelectorAll(FIELD)) {
  if (field.disabled || field.readOnly || (frames.length && field.id === 'e_textarea')) continue;
  items.push({ read: () => field.value, valid: () => field.isConnected, write: value => {
   field.value = value;
   field.dispatchEvent(new Event('input', {bubbles:true}));
   field.dispatchEvent(new Event('change', {bubbles:true}));
  }});
 }
 for (const frame of frames) {
  const doc = frame.contentDocument;
  if (!doc?.body) throw new Error('无法访问富文本编辑器，请切换到纯文本模式。');
  const nodes = [], walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  items.push({
   read: () => nodes.map(n => n.nodeValue).join(''),
   valid: () => frame.isConnected && nodes.every(n => n.isConnected) && doc.body.textContent === nodes.map(n => n.nodeValue).join(''),
   write: value => {
    // Distribute the transformed text back across original text nodes, keeping formatting.
    let offset = 0;
    for (const n of nodes) {
     let remaining = n.nodeValue.replaceAll(Z, '').length;
     const start = offset;
     while (offset < value.length && remaining > 0) { if (value[offset] !== Z) remaining--; offset++; }
     while (value[offset] === Z) offset++;
     n.nodeValue = value.slice(start, offset);
    }
   }
  });
 }
 return items.map(item => ({...item, before:item.read()}));
}
function prepare(root, resume) {
 if (!config.enabled || !config.words) { if (resume) resume(); return; }
 if (busy) return;
 busy = true;
 const version = revision;
 try {
  const items = collect(root);
  if (!items.length) throw new Error('未识别到消息编辑框，请使用标准发帖或私信编辑器。');
  const values = items.map(item => local(item.before));
  if (version !== revision || items.some(item => !item.valid() || item.read() !== item.before)) throw new Error('处理期间内容或设置发生变化，请重新点击发送。');
  items.forEach((item,i) => item.write(values[i]));
  if (items.some((item,i) => !item.valid() || item.read() !== values[i])) throw new Error('编辑器更新了内容，请重新点击发送。');
  replay = {items, values};
  try { if (resume) resume(); } finally { replay = null; }
 } catch (error) { alert('尚未发送：'+error.message); }
 finally { busy = false; }
}
function guard(event, root, resume) {
 if (!config.enabled || !config.words) return;
 if (replay && replay.items.every((item,i) => item.valid() && item.read() === replay.values[i])) return;
 event.preventDefault();
 event.stopImmediatePropagation();
 void prepare(root, resume);
}
window.addEventListener('click', event => {
 const button = event.target instanceof Element ? event.target.closest('button,input,a') : null;
 if (!button) return;
 const isSend = button.matches(SEND) || /(?:post|reply|pm|send).*submit/i.test(button.id) || /^(?:发送|发表|发布|提交)(?:消息|帖子|回复|主题)?$/.test(button.textContent.trim());
 if (!isSend) return;
 const root = button.closest('form') || document;
 if (!root.querySelector(FIELD) && !root.querySelector('iframe#e_iframe')) return;
 guard(event, root, () => button.click());
}, true);
window.addEventListener('submit', event => {
 const form = event.target;
 if (!form.querySelector(FIELD) && !form.querySelector('iframe#e_iframe')) return;
 const button = event.submitter;
 guard(event, form, () => form.requestSubmit(button || undefined));
}, true);
function keydown(event, root = document) {
 if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
 const form = event.target?.closest?.('form');
 root = form || root;
 if (!root.querySelector(FIELD) && !root.querySelector('iframe#e_iframe')) return;
 const button = root.querySelector(SEND);
 guard(event, root, () => {
  if (!button) throw new Error('已处理内容，但未识别到发送按钮，请手动点击发送。');
  button.click();
 });
}
window.addEventListener('keydown', event => {
 if (document.getElementById('s1-filter-settings')) return;
 keydown(event);
}, true);
const watched = new WeakSet(), documents = new WeakSet();
function watchFrames() {
 for (const frame of document.querySelectorAll('iframe#e_iframe')) {
  const attach = () => {
   try {
    const doc = frame.contentDocument;
    if (doc && !documents.has(doc)) {
     documents.add(doc);
     doc.addEventListener('keydown', event => keydown(event, frame.closest('form') || document), true);
    }
   } catch { /* Cross-origin editors are rejected during preparation. */ }
  };
  if (!watched.has(frame)) { watched.add(frame); frame.addEventListener('load',attach); }
  attach();
 }
}
new MutationObserver(watchFrames).observe(document,{childList:true,subtree:true});
let refreshSettings = null;
function applyConfig(value) {
 config = {enabled:value?.enabled !== false, words:normalizeWords(value?.words)};
 revision++;
 local = makeLocal(config.words);
}
GM_addValueChangeListener('accidental-phrases-v3', (_name, _old, value, remote) => {
 if (!remote) return;
 applyConfig(value);
 refreshSettings?.();
});
function settings() {
 if (document.getElementById('s1-filter-settings')) return;
 const previousFocus = document.activeElement;
 const host = document.createElement('div');
 host.id = 's1-filter-settings';
 host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0007;display:grid;place-items:center';
 const shadow = host.attachShadow({mode:'closed'});
 shadow.innerHTML = `<style>
 :host{color-scheme:light dark}*{box-sizing:border-box}
 section{font:15px/1.6 system-ui;background:#fff;color:#222;padding:24px;border-radius:12px;width:min(520px,94vw);max-height:90vh;overflow:auto}
 h2{font-size:20px;margin:0 0 16px}label{display:block;margin:12px 0}
 textarea{display:block;width:100%;height:240px;max-height:45vh;padding:10px;border:1px solid #aaa;border-radius:6px;font:inherit;background:#fff;color:#222;resize:vertical}
 p{font-size:13px;color:#666;margin:10px 0}button{padding:7px 18px;margin-right:8px;cursor:pointer}
 #status:empty{display:none}
 @media(prefers-color-scheme:dark){section{background:#252525;color:#eee}textarea{background:#181818;color:#eee;border-color:#777}p{color:#bbb}}
 </style><section role="dialog" aria-modal="true" aria-labelledby="title">
 <h2 id="title">S1 误伤修正名单</h2>
 <label><input id="enabled" type="checkbox"> 启用发送前修正</label>
 <label for="words">词汇名单</label><textarea id="words" aria-describedby="hint" spellcheck="false"></textarea>
 <p id="hint">每行一个词，至少两个字符。保存时自动去重、清理空行；区分大小写。</p>
 <p id="status" role="status" aria-live="polite"></p>
 <button id="save" type="button">保存</button><button id="close" type="button">取消</button></section>`;
 const get = id => shadow.getElementById(id);
 let baseline;
 const fill = () => {
  get('enabled').checked = config.enabled;
  get('words').value = config.words;
  baseline = {...config};
  get('status').textContent = '';
 };
 fill();
 refreshSettings = () => {
  if (get('words').value === baseline.words && get('enabled').checked === baseline.enabled) fill();
  else get('status').textContent = '其他页面已更新设置。当前草稿已保留，保存将覆盖新设置。';
 };
 const close = () => {
  refreshSettings = null;
  host.remove();
  if (previousFocus?.isConnected) previousFocus.focus();
 };
 get('close').onclick = close;
 get('save').onclick = () => {
  try {
   const next = {enabled:get('enabled').checked, words:normalizeWords(get('words').value)};
   GM_setValue('accidental-phrases-v3', next);
   applyConfig(next);
   close();
  } catch (error) { get('status').textContent = '保存失败：' + error.message; }
 };
 shadow.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key === 'Tab') {
   const first = get('enabled'), last = get('close');
   if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
   else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
  }
 });
 document.body.append(host);
 get('words').focus();
}
GM_registerMenuCommand('管理误伤修正名单', settings);
GM_registerMenuCommand('立即处理当前内容（不发送）', () => prepare(document));
})();
