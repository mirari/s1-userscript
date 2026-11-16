// ==UserScript==
// @name         S1防误伤修正
// @namespace    local.s1.keyword-zwnj
// @version      1.1.0
// @homepageURL  https://github.com/mirari/s1-userscript
// @updateURL    https://raw.githubusercontent.com/mirari/s1-userscript/main/s1-keyword-zwnj.user.js
// @downloadURL  https://raw.githubusercontent.com/mirari/s1-userscript/main/s1-keyword-zwnj.user.js
// @description  发送前自动处理自定义词汇，减少论坛屏蔽词误伤。
// @match        *://*.saraba1st.com/*
// @match        *://*.stage1st.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
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
 return (text, changedWords) => {
  const raw = Array.from(text), chars = [], pos = [];
  raw.forEach((ch,i) => { if (ch !== Z) { chars.push(ch); pos.push(i); } });
  const marks = new Set();
  for (const word of list) {
   const w = Array.from(word);
   for (let i = 0; i <= chars.length - w.length; i++) {
    if (w.every((ch,j) => ch === chars[i+j])) {
     for (let j = i; j < i+w.length-1; j++) {
      marks.add(pos[j]);
      if (raw[pos[j]+1] !== Z) changedWords?.add(word);
     }
    }
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
let toastHost = null, toastTimer, toastMessage;
function showReplacementToast(count) {
 // Feedback must never interrupt submission or steal editor focus.
 try {
  if (!toastHost?.isConnected) {
   toastHost = document.createElement('div');
   toastHost.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;max-width:calc(100vw - 32px)';
   const shadow = toastHost.attachShadow({mode:'closed'});
   shadow.innerHTML = `<style>:host{all:initial}div{font:14px/1.5 system-ui;color:#fff;background:#252525;padding:10px 18px;border-radius:8px;box-shadow:0 3px 14px #0003;text-align:center;overflow-wrap:anywhere}</style><div id="message" role="status" aria-live="polite" aria-atomic="true"></div>`;
   toastMessage = shadow.getElementById('message');
   document.body.append(toastHost);
  }
  toastMessage.textContent = `已自动处理${count}个词汇以防误伤`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastHost?.remove(); toastHost = null; }, 2500);
 } catch { /* Notification failure must not block sending. */ }
}
function prepare(root, resume) {
 if (!config.enabled || !config.words) { if (resume) resume(); return; }
 if (busy) return;
 busy = true;
 const version = revision;
 try {
  const items = collect(root);
  if (!items.length) throw new Error('未识别到消息编辑框，请使用标准发帖或私信编辑器。');
  const changedWords = new Set();
  const values = items.map(item => local(item.before, changedWords));
  if (version !== revision || items.some(item => !item.valid() || item.read() !== item.before)) throw new Error('处理期间内容或设置发生变化，请重新点击发送。');
  items.forEach((item,i) => item.write(values[i]));
  if (items.some((item,i) => !item.valid() || item.read() !== values[i])) throw new Error('编辑器更新了内容，请重新点击发送。');
  if (changedWords.size) showReplacementToast(changedWords.size);
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
const SYNC_KEY = 's1-gist-sync-v1';
const SYNC_FILE = 's1-anti-misfilter.json';
function syncOptions() {
 const value = GM_getValue(SYNC_KEY, {});
 return {id:String(value?.id || ''), token:String(value?.token || ''), baseline:value?.baseline || ''};
}
function syncPayload(value) {
 return JSON.stringify({version:1, enabled:value.enabled, words:normalizeWords(value.words)});
}
function readSyncFile(gist) {
 const file = gist?.files?.[SYNC_FILE];
 if (!file) throw new Error('Gist 中没有本脚本的同步文件。');
 if (file.truncated || typeof file.content !== 'string' || file.content.length > 500000) throw new Error('同步文件过大或不完整。');
 let data;
 try { data = JSON.parse(file.content); } catch { throw new Error('同步文件格式错误。'); }
 if (data?.version !== 1 || typeof data.enabled !== 'boolean' || typeof data.words !== 'string') throw new Error('同步文件版本或内容不受支持。');
 return {enabled:data.enabled, words:normalizeWords(data.words)};
}
function gistRequest(method, id, token, data) {
 if (id && !/^[a-f0-9]{20,64}$/i.test(id)) return Promise.reject(new Error('请填写有效的 Gist ID。'));
 if (!token || /\s/.test(token)) return Promise.reject(new Error('请填写有效的 GitHub 令牌。'));
 return new Promise((resolve, reject) => {
  GM_xmlhttpRequest({method, url:'https://api.github.com/gists' + (id ? '/' + id : ''),
   headers:{Authorization:'Bearer ' + token, Accept:'application/vnd.github+json', 'Content-Type':'application/json', 'X-GitHub-Api-Version':'2022-11-28', 'Cache-Control':'no-cache'},
   anonymous:true, redirect:'error', timeout:20000,
   ...(data ? {data:JSON.stringify(data)} : {}),
   onload:response => {
    if (response.status < 200 || response.status >= 300) {
     const message = {401:'令牌无效或已过期',403:'权限不足或请求受限',404:'Gist 不存在或无权访问'}[response.status] || 'GitHub 请求失败';
     reject(new Error(message + '（' + response.status + '）')); return;
    }
    try { resolve(JSON.parse(response.responseText)); } catch { reject(new Error('GitHub 返回了无法识别的数据。')); }
   },
   onerror:() => reject(new Error('网络请求失败，请稍后重试。')),
   ontimeout:() => reject(new Error('请求超时。若刚创建 Gist，请先在 GitHub 检查是否已创建成功。')),
   onabort:() => reject(new Error('请求已取消。'))
  });
 });
}
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
 details{margin:16px 0}summary{cursor:pointer}details input{width:100%;padding:6px;font:inherit}details button{margin-bottom:8px}
 #status:empty{display:none}
 @media(prefers-color-scheme:dark){section{background:#252525;color:#eee}textarea{background:#181818;color:#eee;border-color:#777}p{color:#bbb}}
 </style><section role="dialog" aria-modal="true" aria-labelledby="title">
 <h2 id="title">S1 误伤修正名单</h2>
 <label><input id="enabled" type="checkbox"> 启用发送前修正</label>
 <label for="words">词汇名单</label><textarea id="words" aria-describedby="hint" spellcheck="false"></textarea>
 <p id="hint">每行一个词，至少两个字符。保存时自动去重、清理空行；区分大小写。</p>
 <details><summary>Gist 同步</summary>
 <p>同步名单和启用状态。首次上传可自动创建 Secret Gist；换设备后填入同一个 ID。</p>
 <label>GitHub 令牌<input id="sync-token" type="password" autocomplete="off" spellcheck="false"></label>
 <label>Gist ID<input id="sync-id" type="text" spellcheck="false" placeholder="首次上传可留空"></label>
 <p>令牌需具有 Gists 读写权限，仅在本机保存。Secret Gist 不是加密存储，知道链接的人可读取。</p>
 <button id="upload" type="button">上传当前名单</button><button id="download" type="button">拉取名单</button>
 <p>上传使用当前编辑内容；拉取后点击保存生效。同步操作会保存连接设置。</p>
 </details>
 <p id="status" role="status" aria-live="polite"></p>
 <button id="save" type="button">保存</button><button id="close" type="button">取消</button></section>`;
 const get = id => shadow.getElementById(id);
 let syncing = false;
 const initialSync = syncOptions();
 get('sync-token').value = initialSync.token;
 get('sync-id').value = initialSync.id;
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
  if (syncing) return;
  refreshSettings = null;
  host.remove();
  if (previousFocus?.isConnected) previousFocus.focus();
 };
 get('close').onclick = close;
 get('save').onclick = () => {
  try {
   const next = {enabled:get('enabled').checked, words:normalizeWords(get('words').value)};
   const oldSync = syncOptions();
   const id = get('sync-id').value.trim();
   if (id && !/^[a-f0-9]{20,64}$/i.test(id)) throw new Error('请填写有效的 Gist ID。');
   GM_setValue(SYNC_KEY, {id, token:get('sync-token').value.trim(), baseline:id === oldSync.id ? oldSync.baseline : ''});
   GM_setValue('accidental-phrases-v3', next);
   applyConfig(next);
   close();
  } catch (error) { get('status').textContent = '保存失败：' + error.message; }
 };
 const sync = async direction => {
  if (syncing) return;
  const controls = ['enabled','words','save','close','upload','download','sync-token','sync-id'];
  const snapshot = {enabled:get('enabled').checked, words:normalizeWords(get('words').value)};
  const draft = get('words').value, version = revision;
  let id = get('sync-id').value.trim();
  const token = get('sync-token').value.trim();
  const previous = syncOptions();
  const sameLocal = () => revision === version && get('words').value === draft && get('enabled').checked === snapshot.enabled;
  syncing = true;
  controls.forEach(name => { get(name).disabled = true; });
  get('status').textContent = '正在同步……';
  try {
   if (direction === 'download' && !id) throw new Error('请先填写 Gist ID。');
   if (id && !/^[a-f0-9]{20,64}$/i.test(id)) throw new Error('请填写有效的 Gist ID。');
   if (!token || /\s/.test(token)) throw new Error('请填写有效的 GitHub 令牌。');
   const connection = {id, token, baseline:id === previous.id ? previous.baseline : ''};
   GM_setValue(SYNC_KEY, connection);
   if (direction === 'download') {
    const remote = readSyncFile(await gistRequest('GET', id, token));
    if (!sameLocal()) throw new Error('本地设置已变化，请重新拉取。');
    if (syncPayload(snapshot) !== syncPayload(remote) && !confirm('用云端名单和开关替换当前编辑内容？点击保存后才会生效。')) {
     get('status').textContent = '已取消拉取。'; return;
    }
    get('enabled').checked = remote.enabled;
    get('words').value = remote.words;
    GM_setValue(SYNC_KEY, {...connection, baseline:syncPayload(remote)});
    get('status').textContent = '已拉取，请点击保存生效。';
   } else {
    const content = syncPayload(snapshot);
    if (id) {
     const gist = await gistRequest('GET', id, token);
     if (gist.public !== false) throw new Error('请使用 Secret Gist，以免名单出现在公开列表中。');
     const remote = readSyncFile(gist);
     const remoteContent = syncPayload(remote);
     if (remoteContent !== content) {
      const conflict = !connection.baseline || remoteContent !== connection.baseline;
      if (!confirm(conflict ? '云端名单有变化或尚未建立同步基线。用当前名单覆盖云端？' : '将当前名单和开关上传并覆盖云端？')) {
       get('status').textContent = '已取消上传。'; return;
      }
      const latest = await gistRequest('GET', id, token);
      if (latest.public !== false || syncPayload(readSyncFile(latest)) !== remoteContent) throw new Error('云端在上传前发生变化，请重新检查后上传。');
      if (!sameLocal()) throw new Error('本地设置已变化，请重新上传。');
      const result = await gistRequest('PATCH', id, token, {files:{[SYNC_FILE]:{content}}});
      if (syncPayload(readSyncFile(result)) !== content) throw new Error('云端返回的内容不一致，请重新拉取检查。');
     }
    } else {
     if (!sameLocal()) throw new Error('本地设置已变化，请重新上传。');
     const result = await gistRequest('POST', '', token, {description:'S1防误伤修正设置', public:false, files:{[SYNC_FILE]:{content}}});
     if (!/^[a-f0-9]{20,64}$/i.test(result.id || '')) throw new Error('未获得有效的 Gist ID，请在 GitHub 检查创建结果。');
     id = result.id;
     get('sync-id').value = id;
     // Persist the new ID immediately so a later error cannot create duplicates.
     GM_setValue(SYNC_KEY, {...connection, id});
     if (syncPayload(readSyncFile(result)) !== content) throw new Error('云端内容校验失败，请重新拉取检查。');
    }
    GM_setValue(SYNC_KEY, {id, token, baseline:content});
    get('status').textContent = '已上传。当前编辑内容仍需点击保存才能在本机生效。';
   }
  } catch (error) { get('status').textContent = '同步失败：' + error.message; }
  finally {
   syncing = false;
   controls.forEach(name => { get(name).disabled = false; });
  }
 };
 get('upload').onclick = () => sync('upload');
 get('download').onclick = () => sync('download');
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
