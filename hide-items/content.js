(() => {
  if (window.__hdiInjected) return;
  window.__hdiInjected = true;

  const STORE_KEY = 'hiddenBySite';
  const SITE = location.hostname;

  /* ------------------------------------------------------------------ *
   * Persistent hiding
   * ------------------------------------------------------------------ */

  let hidden = [];          // saved selectors for this site
  let hideStyle = null;

  function ensureHideStyle() {
    if (!hideStyle || !hideStyle.isConnected) {
      hideStyle = document.createElement('style');
      hideStyle.id = 'hdi-hidden-style';
      (document.head || document.documentElement).appendChild(hideStyle);
    }
    return hideStyle;
  }

  function applyHidden() {
    // One rule per selector so a single bad selector can't kill the rest.
    ensureHideStyle().textContent =
      hidden.map((s) => `${s}{display:none !important}`).join('\n');
  }

  async function loadHidden() {
    const store = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || {};
    hidden = store[SITE] || [];
    applyHidden();
  }

  async function saveHidden() {
    const store = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || {};
    if (hidden.length) store[SITE] = hidden;
    else delete store[SITE];
    await chrome.storage.local.set({ [STORE_KEY]: store });
  }

  loadHidden();

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
      if (document.querySelector(selector) !== el) {
        // Path still resolves elsewhere first - keep it anyway if it matches
        // nothing better, but bail on truly broken paths.
        if (!document.querySelector(selector)) return null;
      }
    } catch (e) {
      return null;
    }
    return selector;
  }

  /* ------------------------------------------------------------------ *
   * Selection session
   * ------------------------------------------------------------------ */

  let active = false;
  let uiHost = null;
  let shadow = null;
  let ui = {};
  let target = null;          // element currently highlighted
  let pending = [];           // [{ el, selector }]
  let rafId = 0;
  let markTimer = 0;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .capture {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      cursor: default;
    }

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

    .hide-btn {
      position: fixed;
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
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.92);
      transition: opacity 0.14s ease, transform 0.14s cubic-bezier(0.32, 1.25, 0.5, 1),
                  background 0.12s ease;
    }
    .hide-btn.show {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    .hide-btn:hover { background: #fff; }
    .hide-btn:active { transform: translate(-50%, -50%) scale(0.96); }
    .hide-btn.compact { padding: 0; width: 32px; justify-content: center; }
    .hide-btn.compact .label { display: none; }
    .hide-btn svg { width: 16px; height: 16px; display: block; }

    .bar {
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

    .bar button {
      height: 30px;
      padding: 0 14px;
      border: none;
      border-radius: 10px;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.08s ease;
    }
    .bar button:active { transform: scale(0.97); }

    .ghost {
      background: transparent;
      color: #007aff;
      padding: 0 10px;
    }
    .ghost:hover { background: rgba(120, 120, 128, 0.12); }

    .secondary {
      background: rgba(120, 120, 128, 0.16);
      color: #1d1d1f;
    }
    .secondary:hover { background: rgba(120, 120, 128, 0.24); }

    .primary {
      background: #007aff;
      color: #fff;
      font-weight: 590;
    }
    .primary:hover { background: #0071eb; }
    .primary:disabled {
      opacity: 0.4;
      cursor: default;
      transform: none;
      background: #007aff;
    }

    .divider {
      width: 1px;
      height: 18px;
      background: rgba(0, 0, 0, 0.14);
      margin: 0 2px;
    }

    [hidden] { display: none !important; }

    @media (prefers-color-scheme: dark) {
      .hide-btn {
        background: rgba(44, 44, 46, 0.92);
        color: #f5f5f7;
        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14),
                    0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .hide-btn:hover { background: rgba(58, 58, 60, 0.96); }
      .bar {
        background: rgba(40, 40, 42, 0.72);
        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14),
                    0 10px 34px rgba(0, 0, 0, 0.5);
      }
      .secondary { background: rgba(120, 120, 128, 0.32); color: #f5f5f7; }
      .secondary:hover { background: rgba(120, 120, 128, 0.44); }
      .ghost { color: #0a84ff; }
      .ghost:hover { background: rgba(120, 120, 128, 0.24); }
      .primary { background: #0a84ff; }
      .primary:hover { background: #3395ff; }
      .divider { background: rgba(255, 255, 255, 0.18); }
    }
  `;

  const EYE_SLASH = `
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.2 8s2.3-4 5.8-4c1 0 1.9.3 2.7.8M13.3 6.2c.3.4.5.8.5.8s-2.3 4-5.8 4c-.6 0-1.1-.1-1.6-.3"
            stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M6.3 6.4a2.2 2.2 0 003.1 3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M2.8 2.8l10.4 10.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;

  function buildUI() {
    uiHost = document.createElement('div');
    uiHost.id = 'hdi-ui-host';
    uiHost.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
      'margin:0;padding:0;border:0;background:transparent;';
    shadow = uiHost.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="capture"></div>
      <div class="highlight"></div>
      <button class="hide-btn" type="button">
        ${EYE_SLASH}<span class="label">Hide</span>
      </button>
      <div class="bar">
        <button class="ghost show-hidden" type="button" hidden></button>
        <div class="divider" hidden></div>
        <button class="secondary cancel" type="button">Cancel</button>
        <button class="primary apply" type="button" disabled>Hide</button>
      </div>`;

    ui = {
      capture: shadow.querySelector('.capture'),
      highlight: shadow.querySelector('.highlight'),
      hideBtn: shadow.querySelector('.hide-btn'),
      bar: shadow.querySelector('.bar'),
      showHidden: shadow.querySelector('.show-hidden'),
      divider: shadow.querySelector('.divider'),
      cancel: shadow.querySelector('.cancel'),
      apply: shadow.querySelector('.apply')
    };

    ui.capture.addEventListener('mousemove', onMove);
    ui.capture.addEventListener('mouseleave', clearTarget);
    ui.capture.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target) hideElement(target);
    });
    ui.hideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target) hideElement(target);
    });
    ui.bar.addEventListener('mouseenter', clearTarget);
    ui.cancel.addEventListener('click', () => stop(false));
    ui.apply.addEventListener('click', () => stop(true));
    ui.showHidden.addEventListener('click', unhideAll);

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

  function pickTarget(x, y) {
    const stack = document.elementsFromPoint(x, y)
      .filter((el) => el !== uiHost && el !== document.documentElement);
    let el = stack[0];
    if (!el || el === document.body) return null;

    // Walk up while the parent is essentially the same box, so we grab the
    // whole card / banner instead of a text node wrapper inside it.
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const a = el.getBoundingClientRect();
      const b = parent.getBoundingClientRect();
      const grows = (b.width * b.height) > (a.width * a.height) * 1.2 + 400;
      if (grows) break;
      el = parent;
      parent = el.parentElement;
    }
    return el;
  }

  function onMove(e) {
    const el = pickTarget(e.clientX, e.clientY);
    if (el === target) return;
    target = el;
    drawTarget();
  }

  function clearTarget() {
    target = null;
    ui.highlight.classList.remove('show');
    ui.hideBtn.classList.remove('show');
  }

  function drawTarget() {
    if (!target || !target.isConnected) { clearTarget(); return; }
    const r = target.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { clearTarget(); return; }

    const h = ui.highlight.style;
    h.top = `${r.top}px`;
    h.left = `${r.left}px`;
    h.width = `${r.width}px`;
    h.height = `${r.height}px`;
    ui.highlight.classList.add('show');

    // Keep the button inside the viewport for very tall / offscreen blocks.
    const cx = Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60);
    const top = Math.min(Math.max(r.top + r.height / 2, 30), window.innerHeight - 90);
    ui.hideBtn.style.left = `${cx}px`;
    ui.hideBtn.style.top = `${top}px`;
    ui.hideBtn.classList.toggle('compact', r.width < 96 || r.height < 44);
    ui.hideBtn.classList.add('show');
  }

  function tick() {
    if (!active) return;
    if (target) drawTarget();
    rafId = requestAnimationFrame(tick);
  }

  /* ----------------------------- actions ---------------------------- */

  function hideElement(el) {
    const selector = cssPath(el);
    clearTarget();
    el.setAttribute('data-hdi-vanish', '');
    setTimeout(() => {
      el.removeAttribute('data-hdi-vanish');
      el.setAttribute('data-hdi-pending', '');
    }, 200);
    pending.push({ el, selector });
    updateBar();
  }

  function updateBar() {
    const n = pending.length;
    ui.apply.disabled = n === 0;
    ui.apply.textContent = n ? `Hide ${n} Item${n > 1 ? 's' : ''}` : 'Hide';

    const showHidden = hidden.length > 0;
    ui.showHidden.hidden = !showHidden;
    ui.divider.hidden = !showHidden;
    ui.showHidden.textContent = `Show Hidden (${hidden.length})`;
  }

  async function unhideAll() {
    hidden = [];
    applyHidden();
    await saveHidden();
    updateBar();
  }

  function start() {
    if (active) return;
    active = true;
    pending = [];
    buildUI();
    document.documentElement.classList.add('hdi-active');
    markCandidates();
    updateBar();

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    rafId = requestAnimationFrame(tick);
  }

  function onScroll() {
    if (target) drawTarget();
    clearTimeout(markTimer);
    markTimer = setTimeout(markCandidates, 150);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); stop(true); }
  }

  async function stop(commit) {
    if (!active) return;
    active = false;

    cancelAnimationFrame(rafId);
    clearTimeout(markTimer);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    window.removeEventListener('keydown', onKey, true);

    for (const item of pending) {
      item.el.removeAttribute('data-hdi-vanish');
      item.el.removeAttribute('data-hdi-pending');
      if (commit && item.selector && !hidden.includes(item.selector)) {
        hidden.push(item.selector);
      }
    }
    pending = [];

    if (commit) {
      applyHidden();
      await saveHidden();
    }

    clearCandidates();
    document.documentElement.classList.remove('hdi-active');
    if (uiHost) uiHost.remove();
    uiHost = shadow = null;
    ui = {};
    target = null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'hdi-toggle') {
      if (active) stop(false);
      else start();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
