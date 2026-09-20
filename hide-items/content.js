(() => {
  if (window.__hdiInjected) return;
  window.__hdiInjected = true;

  const STORE_KEY = 'hiddenBySite';
  const SITE = location.hostname;
  const PATH = location.pathname;
  const IS_TOP = window.top === window;

  /* ------------------------------------------------------------------ *
   * Rules
   *
   * A rule is { s: selector, scope: 'site' | 'page', path?, unlock? }.
   * v1 stored bare selector strings; those normalise to site scope.
   * ------------------------------------------------------------------ */

  let rules = [];
  let hideStyle = null;
  let unlockWatcher = null;
  let unlockTimer = 0;

  const normalize = (r) => (typeof r === 'string' ? { s: r, scope: 'site' } : r);
  const appliesHere = (r) => r.scope !== 'page' || r.path === PATH;

  function ensureHideStyle() {
    if (!hideStyle || !hideStyle.isConnected) {
      hideStyle = document.createElement('style');
      hideStyle.id = 'hdi-hidden-style';
      (document.head || document.documentElement).appendChild(hideStyle);
    }
    return hideStyle;
  }

  function applyRules() {
    // One rule per selector so a single bad selector can't kill the rest.
    ensureHideStyle().textContent = rules
      .filter(appliesHere)
      .map((r) => `${r.s}{display:none !important}`)
      .join('\n');
    refreshUnlock();
    watchUnlock();
  }

  // Sites lock scrolling when a modal opens. Hiding the modal with CSS does not
  // undo that, so unlock while a modal we hid is actually present in the DOM.
  function refreshUnlock() {
    let need = false;
    for (const r of rules) {
      if (!r.unlock || !appliesHere(r)) continue;
      try {
        if (document.querySelector(r.s)) { need = true; break; }
      } catch (e) { /* stale selector */ }
    }
    document.documentElement.classList.toggle('hdi-unlock', need);
  }

  function watchUnlock() {
    if (unlockWatcher) return;
    if (!rules.some((r) => r.unlock && appliesHere(r))) return;
    unlockWatcher = new MutationObserver(() => {
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(refreshUnlock, 100);
    });
    unlockWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function loadRules() {
    const store = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || {};
    rules = (store[SITE] || []).map(normalize);
    applyRules();
  }

  async function saveRules() {
    const store = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || {};
    if (rules.length) store[SITE] = rules;
    else delete store[SITE];
    await chrome.storage.local.set({ [STORE_KEY]: store });
  }

  loadRules();
  document.addEventListener('DOMContentLoaded', refreshUnlock);

  /* ------------------------------------------------------------------ *
   * Selector generation
   * ------------------------------------------------------------------ */

  function cssPath(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === 1) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) &&
          document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }

      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }

      const sameTag = Array.prototype.filter.call(
        parent.children, (c) => c.tagName === node.tagName);
      parts.unshift(sameTag.length > 1
        ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
        : tag);

      node = parent;
    }

    const selector = parts.join('>');
    try {
      if (!document.querySelector(selector)) return null;
    } catch (e) {
      return null;
    }
    return selector;
  }

  /* ------------------------------------------------------------------ *
   * Modal detection
   *
   * The grey backdrop is usually a sibling of the dialog, so hiding the
   * dialog alone leaves the page greyed. Find the wrapper that holds both,
   * or fall back to hiding the dialog and the backdrop as a pair.
   * ------------------------------------------------------------------ */

  function isBackdropLike(el) {
    if (!el || el.nodeType !== 1 || el === uiHost) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;

    const r = el.getBoundingClientRect();
    if (r.width < window.innerWidth * 0.85 || r.height < window.innerHeight * 0.85) return false;

    const tinted = cs.backgroundColor && !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(cs.backgroundColor);
    const blurred = cs.backdropFilter && cs.backdropFilter !== 'none';
    const lifted = parseInt(cs.zIndex, 10) >= 100;
    return Boolean(tinted || blurred || lifted);
  }

  // Returns the elements to hide, or null when this isn't a modal.
  function modalTargets(el) {
    let node = el;
    let depth = 0;

    while (node && node !== document.body && depth++ < 12) {
      const parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;

      if (parent === document.body) {
        // Dialog and backdrop are siblings at the top level - hide both.
        for (const sib of parent.children) {
          if (sib !== node && isBackdropLike(sib)) return [node, sib];
        }
        break;
      }

      // A wrapper holding the dialog plus a separate backdrop element.
      for (const sib of parent.children) {
        if (sib !== node && isBackdropLike(sib)) return [parent];
      }

      // Or the wrapper is itself the full-screen tinted overlay.
      if (isBackdropLike(parent)) return [parent];

      node = parent;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Session state
   * ------------------------------------------------------------------ */

  let active = false;
  let uiHost = null;
  let shadow = null;
  let ui = {};
  let targets = [];          // elements currently highlighted
  let pending = [];          // [{ el, s, unlock }]
  let scope = 'site';
  let rafId = 0;
  let markTimer = 0;
  let pointerInside = false;
  let insideFrame = null;       // top frame: the <iframe> currently handed control
  let frameCounts = new Map();   // top frame only: frameId -> count
  let lastCtxRules = [];         // for Undo after a context-menu hide

  const send = (msg) => { try { chrome.runtime.sendMessage(msg); } catch (e) {} };

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .highlight {
      position: fixed;
      border-radius: 10px;
      background: rgba(0, 122, 255, 0.14);
      box-shadow:
        inset 0 0 0 2px rgba(0, 122, 255, 0.95),
        0 0 0 1px rgba(255, 255, 255, 0.5);
      pointer-events: none;
      opacity: 0;
      transition:
        top 0.12s cubic-bezier(0.32, 0.9, 0.3, 1),
        left 0.12s cubic-bezier(0.32, 0.9, 0.3, 1),
        width 0.12s cubic-bezier(0.32, 0.9, 0.3, 1),
        height 0.12s cubic-bezier(0.32, 0.9, 0.3, 1),
        opacity 0.12s ease;
    }
    .highlight.show { opacity: 1; }
    .highlight.modal {
      background: rgba(255, 149, 0, 0.16);
      box-shadow:
        inset 0 0 0 2px rgba(255, 149, 0, 0.95),
        0 0 0 1px rgba(255, 255, 255, 0.5);
    }

    .capture { position: fixed; inset: 0; pointer-events: auto; cursor: default; }

    .pill {
      position: fixed;
      display: flex;
      gap: 6px;
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.92);
      transition: opacity 0.14s ease,
                  transform 0.14s cubic-bezier(0.32, 1.25, 0.5, 1);
    }
    .pill.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }

    .hide-btn, .inside-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px 0 12px;
      border: none;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.92);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      box-shadow:
        0 0 0 0.5px rgba(0, 0, 0, 0.1),
        0 4px 14px rgba(0, 0, 0, 0.22);
      color: #1d1d1f;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text",
            "Helvetica Neue", Helvetica, Arial, sans-serif;
      letter-spacing: -0.08px;
      white-space: nowrap;
      pointer-events: auto;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.08s ease;
    }
    .hide-btn:hover, .inside-btn:hover { background: #fff; }
    .hide-btn:active, .inside-btn:active { transform: scale(0.96); }
    .hide-btn.compact { padding: 0; width: 32px; justify-content: center; }
    .hide-btn.compact .label { display: none; }
    .hide-btn svg { width: 16px; height: 16px; display: block; }
    .inside-btn { padding: 0 14px; font-weight: 590; color: #007aff; }

    .bar, .toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border-radius: 17px;
      background: rgba(246, 246, 246, 0.72);
      -webkit-backdrop-filter: saturate(180%) blur(30px);
      backdrop-filter: saturate(180%) blur(30px);
      box-shadow:
        0 0 0 0.5px rgba(0, 0, 0, 0.12),
        0 10px 34px rgba(0, 0, 0, 0.2);
      pointer-events: auto;
      font: 500 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text",
            "Helvetica Neue", Helvetica, Arial, sans-serif;
      letter-spacing: -0.08px;
      transform: translateX(-50%);
      animation: bar-in 0.3s cubic-bezier(0.32, 1.2, 0.5, 1) both;
    }
    @keyframes bar-in {
      from { opacity: 0; transform: translateX(-50%) translateY(14px) scale(0.96); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
    }

    .toast { padding: 8px 8px 8px 16px; gap: 12px; }
    .toast.out { animation: bar-out 0.22s ease forwards; }
    @keyframes bar-out {
      to { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.97); }
    }

    .bar button, .toast button {
      height: 30px;
      padding: 0 14px;
      border: none;
      border-radius: 10px;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.08s ease;
    }
    .bar button:active, .toast button:active { transform: scale(0.97); }

    .seg {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 10px;
      background: rgba(120, 120, 128, 0.12);
    }
    .seg-btn {
      height: 26px !important;
      padding: 0 11px !important;
      border-radius: 8px !important;
      background: transparent;
      color: #1d1d1f;
      opacity: 0.6;
    }
    .seg-btn.on {
      background: #fff;
      opacity: 1;
      font-weight: 590;
      box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.12);
    }

    .ghost { background: transparent; color: #007aff; padding: 0 10px; }
    .ghost:hover { background: rgba(120, 120, 128, 0.12); }

    .secondary { background: rgba(120, 120, 128, 0.16); color: #1d1d1f; }
    .secondary:hover { background: rgba(120, 120, 128, 0.24); }

    .primary { background: #007aff; color: #fff; font-weight: 590; }
    .primary:hover { background: #0071eb; }
    .primary:disabled {
      opacity: 0.4; cursor: default; transform: none; background: #007aff;
    }

    .divider { width: 1px; height: 18px; background: rgba(0, 0, 0, 0.14); margin: 0 2px; }
    .toast-text { color: #1d1d1f; }

    [hidden] { display: none !important; }

    @media (prefers-color-scheme: dark) {
      .hide-btn, .inside-btn {
        background: rgba(44, 44, 46, 0.92);
        color: #f5f5f7;
        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .hide-btn:hover, .inside-btn:hover { background: rgba(58, 58, 60, 0.96); }
      .inside-btn { color: #0a84ff; }
      .bar, .toast {
        background: rgba(40, 40, 42, 0.72);
        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 10px 34px rgba(0, 0, 0, 0.5);
      }
      .seg { background: rgba(120, 120, 128, 0.24); }
      .seg-btn { color: #f5f5f7; }
      .seg-btn.on { background: rgba(99, 99, 102, 0.9); }
      .secondary { background: rgba(120, 120, 128, 0.32); color: #f5f5f7; }
      .secondary:hover { background: rgba(120, 120, 128, 0.44); }
      .ghost { color: #0a84ff; }
      .ghost:hover { background: rgba(120, 120, 128, 0.24); }
      .primary { background: #0a84ff; }
      .primary:hover { background: #3395ff; }
      .divider { background: rgba(255, 255, 255, 0.18); }
      .toast-text { color: #f5f5f7; }
    }
  `;

  const EYE_SLASH = `
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.2 8s2.3-4 5.8-4c1 0 1.9.3 2.7.8M13.3 6.2c.3.4.5.8.5.8s-2.3 4-5.8 4c-.6 0-1.1-.1-1.6-.3"
            stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M6.3 6.4a2.2 2.2 0 003.1 3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M2.8 2.8l10.4 10.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;

  function newHost() {
    const host = document.createElement('div');
    host.id = 'hdi-ui-host';
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
      'margin:0;padding:0;border:0;background:transparent;';
    return host;
  }

  function buildUI() {
    uiHost = newHost();
    shadow = uiHost.attachShadow({ mode: 'open' });

    const bar = IS_TOP ? `
      <div class="bar">
        <div class="seg">
          <button class="seg-btn on" type="button" data-scope="site">This Site</button>
          <button class="seg-btn" type="button" data-scope="page">This Page</button>
        </div>
        <div class="divider"></div>
        <button class="ghost show-hidden" type="button" hidden></button>
        <div class="divider dv2" hidden></div>
        <button class="secondary cancel" type="button">Cancel</button>
        <button class="primary apply" type="button" disabled>Hide</button>
      </div>` : '';

    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="capture"></div>
      <div class="highlight"></div>
      <div class="pill">
        <button class="hide-btn" type="button">${EYE_SLASH}<span class="label">Hide</span></button>
        <button class="inside-btn" type="button" hidden>Inside</button>
      </div>
      ${bar}`;

    ui = {
      capture: shadow.querySelector('.capture'),
      highlight: shadow.querySelector('.highlight'),
      pill: shadow.querySelector('.pill'),
      hideBtn: shadow.querySelector('.hide-btn'),
      insideBtn: shadow.querySelector('.inside-btn'),
      bar: shadow.querySelector('.bar'),
      seg: shadow.querySelectorAll('.seg-btn'),
      showHidden: shadow.querySelector('.show-hidden'),
      dv2: shadow.querySelector('.dv2'),
      cancel: shadow.querySelector('.cancel'),
      apply: shadow.querySelector('.apply')
    };

    ui.hideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (targets.length) hideTargets(targets);
    });

    ui.insideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (targets.frame) enterFrame(targets.frame);
    });

    if (IS_TOP) {
      ui.bar.addEventListener('mouseenter', clearTarget);
      ui.cancel.addEventListener('click', () => send({ type: 'hdi-discard' }));
      ui.apply.addEventListener('click', () => send({ type: 'hdi-commit', scope }));
      ui.showHidden.addEventListener('click', () => send({ type: 'hdi-unhide-all' }));
      ui.seg.forEach((b) => b.addEventListener('click', () => {
        scope = b.dataset.scope;
        ui.seg.forEach((o) => o.classList.toggle('on', o === b));
      }));
    }

    document.documentElement.appendChild(uiHost);
  }

  /* --------------------------- candidates --------------------------- */

  function markCandidates() {
    if (!document.body) return;
    const vh = window.innerHeight;
    let count = 0;

    for (const el of document.body.querySelectorAll('*')) {
      if (count > 3000) break;
      if (el === uiHost) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 48 || r.height < 24) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      el.setAttribute('data-hdi-candidate', '');
      count++;
    }
  }

  function clearCandidates() {
    document.querySelectorAll('[data-hdi-candidate]')
      .forEach((el) => el.removeAttribute('data-hdi-candidate'));
  }

  /* ---------------------------- targeting --------------------------- */

  // `precise` (Option held) skips modal expansion so a single part can be picked.
  function resolveFrom(el, precise) {
    if (!el || el === document.body) return [];

    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const a = boxOf(el, 0);
      const b = boxOf(parent, 0);
      if (b.width * b.height > a.width * a.height * 1.2 + 400) break;
      el = parent;
      parent = el.parentElement;
    }

    if (!precise) {
      const modal = modalTargets(el);
      if (modal) { modal.isModal = true; return modal; }
    }
    return [el];
  }

  function pickTargets(x, y, precise) {
    const stack = document.elementsFromPoint(x, y)
      .filter((el) => el !== uiHost && el !== document.documentElement);
    const list = resolveFrom(stack[0], precise);
    if (stack[0] && stack[0].tagName === 'IFRAME') list.frame = stack[0];
    return list;
  }

  // Hand pointer control to a frame's own copy of this script so elements
  // inside it can be picked. The overlay stops swallowing events over it.
  function enterFrame(frameEl) {
    insideFrame = frameEl;
    if (ui.capture) ui.capture.style.pointerEvents = 'none';
    clearTarget();
  }

  function exitFrame() {
    insideFrame = null;
    if (ui.capture) ui.capture.style.pointerEvents = 'auto';
  }

  function sameTargets(a, b) {
    return a.length === b.length && a.every((el, i) => el === b[i]);
  }

  function clearTarget() {
    targets = [];
    if (!ui.highlight) return;
    ui.highlight.classList.remove('show');
    ui.pill.classList.remove('show');
  }

  // A modal wrapper whose children are all position:fixed has a zero-height
  // box of its own, so fall back to what it actually paints.
  function boxOf(el, depth) {
    const r = el.getBoundingClientRect();
    if ((r.width >= 1 && r.height >= 1) || (depth || 0) >= 3) return r;

    let t = Infinity, l = Infinity, b = -Infinity, rt = -Infinity, found = false;
    for (const child of el.children) {
      if (child === uiHost) continue;
      const q = boxOf(child, (depth || 0) + 1);
      if (q.width < 1 || q.height < 1) continue;
      found = true;
      t = Math.min(t, q.top); l = Math.min(l, q.left);
      b = Math.max(b, q.bottom); rt = Math.max(rt, q.right);
    }
    return found
      ? { top: t, left: l, width: rt - l, height: b - t, bottom: b, right: rt }
      : r;
  }

  function unionRect(list) {
    let t = Infinity, l = Infinity, b = -Infinity, r = -Infinity;
    for (const el of list) {
      const q = boxOf(el, 0);
      if (q.width < 1 || q.height < 1) continue;
      t = Math.min(t, q.top); l = Math.min(l, q.left);
      b = Math.max(b, q.bottom); r = Math.max(r, q.right);
    }
    if (t === Infinity) return { top: 0, left: 0, width: 0, height: 0 };
    return { top: t, left: l, width: r - l, height: b - t };
  }

  function drawTarget() {
    if (!targets.length || !targets.every((el) => el.isConnected)) { clearTarget(); return; }
    const r = unionRect(targets);
    if (r.width < 1 || r.height < 1) { clearTarget(); return; }

    const h = ui.highlight.style;
    h.top = `${r.top}px`;
    h.left = `${r.left}px`;
    h.width = `${r.width}px`;
    h.height = `${r.height}px`;
    ui.highlight.classList.add('show');
    ui.highlight.classList.toggle('modal', Boolean(targets.isModal));

    const cx = Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60);
    const cy = Math.min(Math.max(r.top + r.height / 2, 30), window.innerHeight - 90);
    ui.pill.style.left = `${cx}px`;
    ui.pill.style.top = `${cy}px`;
    ui.hideBtn.classList.toggle('compact',
      (r.width < 96 || r.height < 44) && !targets.frame);
    ui.hideBtn.querySelector('.label').textContent = targets.isModal ? 'Hide Popup' : 'Hide';
    ui.insideBtn.hidden = !targets.frame;
    ui.pill.classList.add('show');
  }

  function tick() {
    if (!active) return;
    if (targets.length) drawTarget();
    rafId = requestAnimationFrame(tick);
  }

  /* ----------------------------- hiding ----------------------------- */

  function vanish(el) {
    el.setAttribute('data-hdi-vanish', '');
    setTimeout(() => {
      el.removeAttribute('data-hdi-vanish');
      el.setAttribute('data-hdi-pending', '');
    }, 200);
  }

  function hideTargets(list) {
    const isModal = Boolean(list.isModal);
    const copy = list.slice();
    clearTarget();
    for (const el of copy) {
      const s = cssPath(el);
      vanish(el);
      pending.push({ el, s, unlock: isModal });
    }
    if (!IS_TOP) send({ type: 'hdi-frame-count', n: pending.length });
    updateBar();
  }

  function totalPending() {
    let n = pending.length;
    for (const v of frameCounts.values()) n += v;
    return n;
  }

  function updateBar() {
    if (!IS_TOP || !ui.apply) return;
    const n = totalPending();
    ui.apply.disabled = n === 0;
    ui.apply.textContent = n ? `Hide ${n} Item${n > 1 ? 's' : ''}` : 'Hide';

    const has = rules.length > 0;
    ui.showHidden.hidden = !has;
    ui.dv2.hidden = !has;
    ui.showHidden.textContent = `Show Hidden (${rules.length})`;
  }

  /* ------------------------ interaction capture --------------------- *
   * No full-screen overlay: page events are swallowed at window capture
   * instead. That leaves cross-origin iframes free to run their own copy
   * of this script and handle hovers inside themselves.
   * ------------------------------------------------------------------ */

  const BLOCKED = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick',
                   'pointerdown', 'pointerup', 'contextmenu', 'touchstart',
                   'touchend', 'keypress', 'submit'];

  // Events on the capture overlay retarget to the shadow host, so the host
  // alone can't tell "page hover" from "clicked our own button".
  function ourPart(e) {
    if (!uiHost) return null;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.length || path.indexOf(uiHost) === -1) return null;
    return path[0] === ui.capture ? 'capture' : 'ui';
  }

  function swallow(e) {
    if (ourPart(e) === 'ui') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click' && targets.length) hideTargets(targets);
  }

  function onMove(e) {
    if (ourPart(e) === 'ui') return;
    e.stopPropagation();

    if (insideFrame) {
      if (!insideFrame.isConnected) {
        exitFrame();
      } else {
        const f = insideFrame.getBoundingClientRect();
        if (e.clientX >= f.left && e.clientX <= f.right &&
            e.clientY >= f.top && e.clientY <= f.bottom) return;
        exitFrame();
      }
    }

    if (!pointerInside) {
      pointerInside = true;
      if (!IS_TOP) send({ type: 'hdi-pointer', on: true });
    }

    const next = pickTargets(e.clientX, e.clientY, e.altKey);
    if (sameTargets(next, targets) && Boolean(next.isModal) === Boolean(targets.isModal)) return;
    targets = next;
    drawTarget();
  }

  function onLeave() {
    if (!pointerInside) return;
    pointerInside = false;
    if (!IS_TOP) send({ type: 'hdi-pointer', on: false });
    clearTarget();
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      send({ type: 'hdi-discard' });
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      send({ type: 'hdi-commit', scope });
    } else {
      e.stopPropagation();
    }
  }

  function onScroll() {
    if (targets.length) drawTarget();
    clearTimeout(markTimer);
    markTimer = setTimeout(markCandidates, 150);
  }

  /* ---------------------------- lifecycle --------------------------- */

  function start() {
    if (active) return;
    active = true;
    pending = [];
    frameCounts = new Map();
    scope = 'site';
    buildUI();
    document.documentElement.classList.add('hdi-active');
    markCandidates();
    updateBar();

    window.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseleave', onLeave, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
    BLOCKED.forEach((t) => window.addEventListener(t, swallow, true));
    rafId = requestAnimationFrame(tick);
  }

  async function stop(commit, chosenScope) {
    if (!active) return;
    active = false;

    cancelAnimationFrame(rafId);
    clearTimeout(markTimer);
    window.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseleave', onLeave, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    BLOCKED.forEach((t) => window.removeEventListener(t, swallow, true));

    const use = chosenScope || 'site';
    for (const p of pending) {
      p.el.removeAttribute('data-hdi-vanish');
      p.el.removeAttribute('data-hdi-pending');
      if (!commit || !p.s) continue;
      if (rules.some((r) => r.s === p.s && r.scope === use && (use !== 'page' || r.path === PATH))) continue;
      const rule = { s: p.s, scope: use };
      if (use === 'page') rule.path = PATH;
      if (p.unlock) rule.unlock = true;
      rules.push(rule);
    }
    pending = [];
    pointerInside = false;
    insideFrame = null;

    if (commit) {
      applyRules();
      await saveRules();
    }

    clearCandidates();
    document.documentElement.classList.remove('hdi-active');
    if (uiHost) uiHost.remove();
    uiHost = shadow = null;
    ui = {};
    targets = [];
  }

  async function unhideAll() {
    rules = [];
    applyRules();
    await saveRules();
    updateBar();
  }

  /* ------------------------ context menu hide ----------------------- */

  let lastContext = null;
  document.addEventListener('contextmenu', (e) => {
    if (active) return;
    lastContext = e.target;
  }, true);

  async function contextHide(useScope) {
    if (!lastContext || !lastContext.isConnected) return;
    const list = resolveFrom(lastContext, false);
    if (!list.length) return;

    lastCtxRules = [];
    for (const el of list) {
      const s = cssPath(el);
      if (!s) continue;
      const rule = { s, scope: useScope };
      if (useScope === 'page') rule.path = PATH;
      if (list.isModal) rule.unlock = true;
      rules.push(rule);
      lastCtxRules.push(rule);
      vanish(el);
      setTimeout(() => el.removeAttribute('data-hdi-pending'), 220);
    }
    if (!lastCtxRules.length) return;

    applyRules();
    await saveRules();

    const text = list.isModal ? 'Popup hidden' : 'Item hidden';
    if (IS_TOP) showToast(text);
    else send({ type: 'hdi-toast', text });
  }

  async function undoContext() {
    if (!lastCtxRules.length) return;
    rules = rules.filter((r) => !lastCtxRules.includes(r));
    lastCtxRules = [];
    applyRules();
    await saveRules();
  }

  /* ------------------------------ toast ----------------------------- */

  let toastHost = null;
  let toastTimer = 0;

  function showToast(text) {
    if (toastHost) toastHost.remove();
    toastHost = newHost();
    const sr = toastHost.attachShadow({ mode: 'open' });
    sr.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="toast">
        <span class="toast-text">${text}</span>
        <button class="secondary toast-undo" type="button">Undo</button>
      </div>`;

    const close = () => {
      const t = sr.querySelector('.toast');
      if (t) t.classList.add('out');
      setTimeout(() => { if (toastHost) { toastHost.remove(); toastHost = null; } }, 220);
    };

    sr.querySelector('.toast-undo').addEventListener('click', () => {
      send({ type: 'hdi-undo' });
      clearTimeout(toastTimer);
      close();
    });

    document.documentElement.appendChild(toastHost);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(close, 5000);
  }

  /* ---------------------------- messaging --------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'hdi-start': start(); break;
      case 'hdi-apply': stop(true, msg.scope); break;
      case 'hdi-cancel': stop(false); break;
      case 'hdi-unhide': unhideAll(); break;
      case 'hdi-ctx-hide': contextHide(msg.scope); break;
      case 'hdi-ctx-show': unhideAll(); break;
      case 'hdi-undo-last': undoContext(); break;
      case 'hdi-toast': if (IS_TOP) showToast(msg.text); break;
      case 'hdi-count':
        if (IS_TOP && active) { frameCounts.set(msg.frameId, msg.n); updateBar(); }
        break;
      case 'hdi-frame-pointer':
        if (!IS_TOP || !active) break;
        if (msg.on) clearTarget();
        else if (insideFrame) exitFrame();
        break;
      default: break;
    }
    sendResponse({ ok: true });
    return false;
  });
})();
