/* ============================================================
   GST Calculator — CodeByRushi
   Real-time GST calculation with custom numeric keypad

   Architecture
   ────────────
   1. State             – single source of truth
   2. DOM cache         – look up elements once
   3. Format            – Indian-locale ₹ formatter
   4. Input handling    – append / backspace / clear / 00 / decimal
   5. Calculation       – base × rate → GST & total
                          (mode-aware: 'add' or 'remove' GST)
   6. Render            – push numbers into the DOM, pulse
   7. Rate binding      – 4 pill buttons
   8. GST mode toggle   – segmented control (GST+ / GST-)
   9. Drawer            – Material 3 nav drawer
   10. Theme            – persisted in localStorage (default dark)
   11. Keypad           – event delegation on the keypad footer
   12. Ripple           – Material-style click feedback
   13. Defenses         – block the system keyboard from popping
   14. PWA              – service worker registration
   15. Init             – wire everything up
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     1. STATE
     ============================================================ */
  const state = {
    /** Raw digit string the user is typing. e.g. "1234.5" */
    rawValue: '',
    /** Currently selected GST rate (5 | 12 | 18 | 28) */
    rate: 18,
    /**
     * Calculation mode:
     *   'add'    → user enters BASE price; output = price + GST (default)
     *   'remove' → user enters FINAL price; output = base price
     * The actual math is done in calculate(); the labels and
     * which card is "hero" are swapped in render().
     */
    mode: 'add',
    /**
     * Theme preference stored between sessions.
     *  - 'dark'   → dark (default on first visit)
     *  - 'light'  → light
     * Once the user picks one, the choice is firm and persisted.
     */
    themePref: 'dark',
    /** What theme is currently rendered. Used by the toggle. */
    currentTheme: 'dark',
    /** Drawer open/closed. */
    drawerOpen: false,
  };

  const THEME_KEY  = 'gst-theme';
  const MODE_KEY   = 'gst-mode';
  const RATE_KEY   = 'gst-rate';

  /* ============================================================
     1b. APP LINKS — single source of truth for external URLs
     Replace the TODO placeholders with your real values before
     publishing to the Play Store.
     ============================================================ */
  const APP_LINKS = {
    // TODO: replace with your real Play Store app id, e.g. com.codebyrushi.gstcalc
    playStoreId:  'YOUR_APP_ID',
    // TODO: replace with your public Privacy Policy URL
    privacyUrl:   'https://example.com/privacy-policy',
    // TODO: replace with your developer email
    contactEmail: 'you@example.com',
    // TODO: replace with your Play Store developer id
    devId:        'YOUR_DEVELOPER_ID',
    // TODO: replace with your real app version (kept in sync with manifest)
    appVersion:   '1.0.0',
    // Optional: localised share text used by the Share action
    shareText:    'Try this GST Calculator — fast, simple and offline.',
  };

  /** Helper: build a Play Store URL for the current app id. */
  function playStoreUrl() {
    return 'https://play.google.com/store/apps/details?id=' + APP_LINKS.playStoreId;
  }

  /** Helper: build a Play Store "more apps by this developer" URL. */
  function developerUrl() {
    return 'https://play.google.com/store/apps/dev?id=' + APP_LINKS.devId;
  }

  /* ============================================================
     2. DOM CACHE
     ============================================================ */
  const $ = (id) => document.getElementById(id);

  const els = {
    amountInput:    $('amountInput'),
    amountValue:    $('amountValue'),
    displayLabel:   $('displayLabel'),
    displayTag:     $('displayTag'),
    totalValue:     $('totalValue'),
    heroLabel:      $('heroLabel'),
    heroTag:        $('heroTag'),
    gstValue:       $('gstValue'),
    baseValue:      $('baseValue'),
    baseLabel:      $('baseLabel'),
    cgstValue:      $('cgstValue'),
    sgstValue:      $('sgstValue'),
    igstValue:      $('igstValue'),
    cgstRate:       $('cgstRate'),
    sgstRate:       $('sgstRate'),
    igstRate:       $('igstRate'),
    rateBtns:       document.querySelectorAll('.rate-btn'),
    keypad:         $('keypad'),
    menuBtn:        $('menuBtn'),
    drawer:         $('drawer'),
    scrim:          $('scrim'),
    themeSubmenu:   $('themeSubmenu'),
    gstModeToggle:  $('gstModeToggle'),
    segIndicator:   $('segIndicator'),
    breakdown:      $('breakdown'),
    breakdownClose: $('breakdownClose'),
    aboutModal:     $('aboutModal'),
    aboutVersion:   $('aboutVersion'),
    drawerVersion:  $('drawerVersion'),
    themeColorMeta: $('themeColorMeta'),
    heroCard:       document.querySelector('.card.hero'),
  };

  /* ============================================================
     3. FORMATTERS
     Indian grouping: ₹1,23,45,678.90
     ============================================================ */
  function formatINR(value) {
    if (!isFinite(value) || isNaN(value)) return '₹0.00';
    const n = Math.abs(value);
    const [intPart, decPart] = n.toFixed(2).split('.');
    const lastThree = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    const grouped = rest === ''
      ? lastThree
      : rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
    return '₹' + grouped + '.' + decPart;
  }

  /**
   * Format for the big display — strips the ₹ (we render it separately)
   * and trims trailing ".00" for whole-rupee values for a cleaner look.
   */
  function formatDisplay(raw) {
    if (raw === '' || raw === '.' || raw === '0' || raw === '0.0' || raw === '0.00') {
      return '0';
    }
    const n = parseFloat(raw);
    if (isNaN(n)) return '0';
    let s = formatINR(n);
    if (s.endsWith('.00')) s = s.slice(0, -3);
    return s.replace(/^₹/, '');
  }

  /* ============================================================
     4. INPUT HANDLING
     Custom keypad writes to state.rawValue, then we re-render.
     The input always represents the user-entered amount; whether
     it is the BASE or the FINAL depends on state.mode.
     ============================================================ */
  const MAX_LEN = 12;        // hard cap to keep layout sane
  const MAX_DEC = 2;         // 2 decimal places

  function appendDigit(d) {
    // Reject if at cap
    if (state.rawValue.length >= MAX_LEN) return;

    // Decimal point handling
    if (d === '.') {
      if (state.rawValue === '') {
        state.rawValue = '0.';
      } else if (!state.rawValue.includes('.')) {
        state.rawValue += '.';
      }
      // if already has '.', ignore (no double dots)
      afterChange();
      return;
    }

    // Digit handling
    if (state.rawValue === '0') {
      // Replace leading zero with the digit
      state.rawValue = d;
    } else if (state.rawValue === '0.') {
      // "0." + digit → "0.X"
      state.rawValue = '0.' + d;
    } else {
      // Check decimal cap
      const dotIdx = state.rawValue.indexOf('.');
      if (dotIdx !== -1) {
        const decLen = state.rawValue.length - dotIdx - 1;
        if (decLen >= MAX_DEC) return;     // ignore extra decimal digits
      }
      state.rawValue += d;
    }
    afterChange();
  }

  function appendDoubleZero() {
    if (state.rawValue === '' || state.rawValue === '0') {
      // Stay at 0; "00" alone is not a meaningful number
      afterChange();
      return;
    }
    if (state.rawValue.length >= MAX_LEN) return;

    const dotIdx = state.rawValue.indexOf('.');
    if (dotIdx === -1) {
      // Pure integer: append two zeros
      state.rawValue += '00';
    } else {
      // Decimal: pad to 2 places max
      const intPart = state.rawValue.slice(0, dotIdx);
      const decPart = state.rawValue.slice(dotIdx + 1);
      const pad = '0'.repeat(Math.max(0, MAX_DEC - decPart.length));
      state.rawValue = intPart + '.' + (decPart + pad).slice(0, MAX_DEC);
    }
    afterChange();
  }

  function backspace() {
    if (state.rawValue.length <= 1) {
      state.rawValue = '';
    } else {
      state.rawValue = state.rawValue.slice(0, -1);
    }
    afterChange();
  }

  function clearAll() {
    state.rawValue = '';
    afterChange();
  }

  /* ============================================================
     5. CALCULATION
     Mode-aware. Pure functions of the user-entered amount and
     the selected rate — no DOM access here.

     GST+ (mode = 'add'):
       user types BASE → we show GST amount and TOTAL (base + GST)

     GST- (mode = 'remove'):
       user types FINAL → we show GST amount and BASE = final − GST
     ============================================================ */
  function calculate() {
    const entered = parseAmount();   // user-entered value
    const rate = state.rate;
    const r = rate / 100;

    let base, gst, total;
    if (state.mode === 'add') {
      base  = entered;
      gst   = round2(base * r);
      total = round2(base + gst);
    } else {
      // GST- : entered is the final (incl. GST) amount; back out the base
      total = entered;
      base  = round2(total / (1 + r));
      gst   = round2(total - base);
    }
    const half = round2(gst / 2);

    return { base, gst, total, cgst: half, sgst: half, igst: gst };
  }

  function parseAmount() {
    const n = parseFloat(state.rawValue);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /* ============================================================
     6. RENDER
     Push the current state into the DOM with subtle animations.
     The labels switch based on the active mode so the user
     always knows what they typed and what was calculated.
     ============================================================ */
  function afterChange() {
    // Keep the hidden input in sync (for accessibility/forms)
    els.amountInput.value = state.rawValue;

    // Big amount display (no ₹, no .00 on whole-rupee)
    els.amountValue.textContent = formatDisplay(state.rawValue);

    // Mode-specific labels
    // GST+ : user types BASE → hero shows TOTAL, side card shows BASE
    // GST- : user types FINAL → hero shows the CALCULATED BASE, side card shows FINAL
    if (state.mode === 'add') {
      els.displayLabel.textContent = 'Base Price';
      els.heroLabel.textContent   = 'Total';
      els.heroTag.textContent     = 'incl. GST';
      els.baseLabel.textContent   = 'Base Price';
    } else {
      els.displayLabel.textContent = 'Final Price';
      els.heroLabel.textContent   = 'Base Price';
      els.heroTag.textContent     = 'excl. GST';
      els.baseLabel.textContent   = 'Final Price';
    }

    // Hint text changes once the user has typed something
    if (state.rawValue === '' || state.rawValue === '0') {
      els.displayTag.textContent = 'Type using keypad below';
    } else if (state.mode === 'add') {
      els.displayTag.textContent = `${state.rate}% GST applied`;
    } else {
      els.displayTag.textContent = `${state.rate}% GST removed`;
    }

    // Update the rate labels in the breakdown (e.g., "CGST (9%)")
    const halfRate = state.rate / 2;
    els.cgstRate.textContent = `(${halfRate}%)`;
    els.sgstRate.textContent = `(${halfRate}%)`;
    els.igstRate.textContent = `(${state.rate}%)`;

    // Calculate and render results. Card-value mapping is mode-aware:
    //   GST+  : hero=total, gst=gst,    base=base
    //   GST-  : hero=base,  gst=gst,    base=total   (base card now shows the FINAL value)
    const r = calculate();
    if (state.mode === 'add') {
      setText(els.totalValue, formatINR(r.total), true);   // hero card — pulse
      setText(els.gstValue,   formatINR(r.gst),   true);
      setText(els.baseValue,  formatINR(r.base),  true);
    } else {
      // In GST- mode the hero card displays the calculated BASE, and the
      // side card labeled "Final Price" displays the user-entered TOTAL.
      setText(els.totalValue, formatINR(r.base),  true);   // hero = base
      setText(els.gstValue,   formatINR(r.gst),   true);
      setText(els.baseValue,  formatINR(r.total), true);   // side = final
    }
    setText(els.cgstValue,  formatINR(r.cgst));
    setText(els.sgstValue,  formatINR(r.sgst));
    setText(els.igstValue,  formatINR(r.igst));
  }

  /**
   * Update a DOM element's text only when it actually changes,
   * optionally triggering the value-pulse animation.
   */
  function setText(el, newText, pulse) {
    if (!el) return;
    if (el.textContent === newText) return;
    el.textContent = newText;
    if (pulse) {
      el.classList.remove('value-changed');
      // Force a reflow so the animation can restart
      void el.offsetWidth;
      el.classList.add('value-changed');
    }
  }

  /* ============================================================
     7. RATE BINDING
     ============================================================ */
  els.rateBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const newRate = parseInt(btn.dataset.rate, 10);
      if (newRate === state.rate) return;

      els.rateBtns.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      state.rate = newRate;
      saveRate();
      haptic(8);
      afterChange();
    });
  });

  /* ============================================================
     7b. CGST/SGST/IGST BREAKDOWN
     ============================================================ */
  function showBreakdown() {
    if (!els.breakdown) return;
    els.breakdown.setAttribute('open', '');
    document.body.classList.add('breakdown-open');
  }

  function hideBreakdown() {
    if (!els.breakdown) return;
    els.breakdown.removeAttribute('open');
    document.body.classList.remove('breakdown-open');
  }

  function toggleBreakdown() {
    if (!els.breakdown) return;
    if (els.breakdown.hasAttribute('open')) {
      hideBreakdown();
    } else {
      showBreakdown();
    }
  }

  if (els.breakdown) {
    els.breakdown.addEventListener('toggle', () => {
      const isOpen = els.breakdown.hasAttribute('open');
      document.body.classList.toggle('breakdown-open', isOpen);
    });
  }

  if (els.breakdownClose) {
    els.breakdownClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideBreakdown();
      haptic(8);
    });
  }

  /* ============================================================
     7c. GST MODE TOGGLE (segmented control)
     The indicator is positioned with a CSS transform; we move it
     by setting a CSS variable that the transition animates.
     ============================================================ */
  function applyModeUI() {
    if (!els.gstModeToggle) return;
    const btns = els.gstModeToggle.querySelectorAll('.seg-btn');
    btns.forEach((b) => {
      const on = b.dataset.mode === state.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    // Slide the indicator: 0% for the first half, 100% for the second.
    if (els.segIndicator) {
      const offset = state.mode === 'add' ? '0%' : '100%';
      els.segIndicator.style.setProperty('--seg-translate', offset);
    }
  }

  function setMode(next) {
    if (next !== 'add' && next !== 'remove') return;
    if (state.mode === next) return;
    state.mode = next;
    saveMode();
    applyModeUI();
    haptic(10);
    afterChange();
  }

  if (els.gstModeToggle) {
    els.gstModeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      setMode(btn.dataset.mode);
    });
  }

  /* ============================================================
     8. THEME
     Default is dark. User's choice persists in localStorage.
     ============================================================ */
  function loadThemePref() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') {
        state.themePref = saved;
      } else {
        state.themePref = 'dark';      // default per spec
      }
    } catch (e) { state.themePref = 'dark'; }
  }

  function saveThemePref() {
    try { localStorage.setItem(THEME_KEY, state.themePref); } catch (e) { /* ignore */ }
  }

  function applyTheme() {
    const resolved = state.themePref === 'light' ? 'light' : 'dark';
    state.currentTheme = resolved;
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = els.themeColorMeta;
    if (meta) {
      meta.setAttribute('content', resolved === 'light' ? '#F4F6FB' : '#0F1115');
    }
    // Refresh the radio checkmarks in the drawer's theme submenu
    document.querySelectorAll('.drawer-subitem[data-theme-choice]').forEach((el) => {
      const on = el.dataset.themeChoice === resolved;
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function setTheme(next) {
    if (next !== 'light' && next !== 'dark') return;
    state.themePref = next;
    saveThemePref();
    applyTheme();
    haptic(10);
  }

  /* ============================================================
     9. DRAWER — Material 3 navigation drawer
     Open/close animation is pure CSS via .drawer-open on body.
     The scrim also lives on the same body class so it shows up
     in sync with the slide.
     ============================================================ */
  function openDrawer() {
    if (state.drawerOpen) return;
    state.drawerOpen = true;
    document.body.classList.add('drawer-open');
    if (els.drawer) els.drawer.setAttribute('aria-hidden', 'false');
    haptic(8);
  }

  function closeDrawer() {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    document.body.classList.remove('drawer-open');
    if (els.drawer) els.drawer.setAttribute('aria-hidden', 'true');
  }

  function toggleDrawer() {
    if (state.drawerOpen) closeDrawer();
    else openDrawer();
  }

  if (els.menuBtn) {
    els.menuBtn.addEventListener('click', toggleDrawer);
  }
  if (els.scrim) {
    els.scrim.addEventListener('click', closeDrawer);
  }
  // Escape closes the drawer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerOpen) closeDrawer();
  });

  /* ---------- Drawer action routing ---------- */
  function rateApp() {
    // Open Play Store listing; in a WebView the host handles the intent.
    const url = playStoreUrl();
    window.open(url, '_blank', 'noopener');
  }

  function shareApp() {
    const url  = playStoreUrl();
    const text = APP_LINKS.shareText + ' ' + url;
    if (navigator.share) {
      navigator.share({ title: 'GST Calculator', text, url }).catch(() => {});
    } else {
      // Fallback: copy the link to clipboard
      copyToClipboard(url);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        // Older Android WebViews may not support clipboard API; try the
        // legacy execCommand path as a last resort.
        legacyCopy(text);
      });
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function openPrivacy() {
    window.open(APP_LINKS.privacyUrl, '_blank', 'noopener');
  }

  function contactDeveloper() {
    const subject = encodeURIComponent('GST Calculator — Feedback');
    const body    = encodeURIComponent(
      'Hi CodeByRushi,\n\n' +
      'I’m using your GST Calculator app and would like to share some feedback:\n\n'
    );
    const href = `mailto:${APP_LINKS.contactEmail}?subject=${subject}&body=${body}`;
    // Use a hidden <a> click so the WebView treats it as a user gesture.
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function moreApps() {
    window.open(developerUrl(), '_blank', 'noopener');
  }

  function openAbout() {
    if (!els.aboutModal) return;
    if (els.aboutVersion) els.aboutVersion.textContent = 'Version ' + APP_LINKS.appVersion;
    els.aboutModal.classList.add('open');
    els.aboutModal.setAttribute('aria-hidden', 'false');
  }

  function closeAbout() {
    if (!els.aboutModal) return;
    els.aboutModal.classList.remove('open');
    els.aboutModal.setAttribute('aria-hidden', 'true');
  }

  // Route drawer-item clicks by data-action
  document.querySelectorAll('.drawer-item[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const action = el.dataset.action;
      // For the theme row we use a separate handler (expandable submenu)
      if (action === 'theme-toggle') return;
      haptic(8);
      switch (action) {
        case 'home':    closeDrawer(); break;
        case 'rate':    rateApp();        closeDrawer(); break;
        case 'share':   shareApp();       closeDrawer(); break;
        case 'about':   openAbout();      closeDrawer(); break;
        case 'privacy': openPrivacy();    closeDrawer(); break;
        case 'contact': contactDeveloper(); closeDrawer(); break;
        case 'more':    moreApps();       closeDrawer(); break;
      }
    });
  });

  // Theme row: clicking the row toggles the submenu; clicking a
  // submenu item picks the theme (and closes the submenu + drawer).
  const themeRow = document.querySelector('.drawer-item-expandable[data-action="theme-toggle"]');
  if (themeRow) {
    themeRow.addEventListener('click', (e) => {
      // Submenu clicks are handled below; only collapse/expand for the row itself
      if (e.target.closest('.drawer-submenu')) return;
      themeRow.classList.toggle('expanded');
    });
  }
  document.querySelectorAll('.drawer-subitem[data-theme-choice]').forEach((el) => {
    el.addEventListener('click', () => {
      setTheme(el.dataset.themeChoice);
      if (themeRow) themeRow.classList.remove('expanded');
      closeDrawer();
    });
  });

  // About modal: any element with data-modal-close closes it
  document.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', closeAbout);
  });

  /* ============================================================
     10. KEYPAD — event delegation
     ============================================================ */
  els.keypad.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    const k = btn.dataset.key;

    switch (k) {
      case 'backspace': backspace();    break;
      case 'clear':     clearAll();     break;
      case '00':        appendDoubleZero(); break;
      case '.':         appendDigit('.'); break;
      default:          appendDigit(k);
    }
    haptic(8);
  });

  /* ============================================================
     11. RIPPLE — Material-style click feedback
     Adds a .ripple <span> sized from the click position. The
     element auto-cleans when the CSS animation ends.
     ============================================================ */
  function attachRipple(el) {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      // Ignore non-primary buttons & right-clicks
      if (e.button !== undefined && e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width  = size + 'px';
      span.style.height = size + 'px';
      span.style.left   = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top    = (e.clientY - rect.top  - size / 2) + 'px';
      el.appendChild(span);
      span.addEventListener('animationend', () => span.remove(), { once: true });
    });
  }

  // Apply ripple to every interactive surface that doesn't already
  // use a custom press animation.
  document.querySelectorAll(
    '.key, .rate-btn, .seg-btn, .icon-btn, .drawer-item, .drawer-subitem, .breakdown-back, .modal-btn'
  ).forEach(attachRipple);

  /* ============================================================
     12. PREVENT THE SYSTEM KEYBOARD
     ============================================================ */
  function blockKeyboard(e) {
    e.preventDefault();
    if (els.amountInput) els.amountInput.blur();
  }

  if (els.amountInput) {
    els.amountInput.addEventListener('focus', () => {
      requestAnimationFrame(() => els.amountInput.blur());
    });
    ['touchstart', 'mousedown', 'click', 'keydown', 'keyup', 'input']
      .forEach((ev) => els.amountInput.addEventListener(ev, blockKeyboard));
  }

  /* ============================================================
     13. HAPTICS
     ============================================================ */
  function haptic(ms) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================
     14. PERSISTENCE HELPERS
     ============================================================ */
  function loadMode() {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === 'add' || saved === 'remove') state.mode = saved;
    } catch (e) { /* ignore */ }
  }
  function saveMode() {
    try { localStorage.setItem(MODE_KEY, state.mode); } catch (e) { /* ignore */ }
  }
  function loadRate() {
    try {
      const saved = parseInt(localStorage.getItem(RATE_KEY), 10);
      if (saved === 5 || saved === 12 || saved === 18 || saved === 28) {
        state.rate = saved;
      }
    } catch (e) { /* ignore */ }
  }
  function saveRate() {
    try { localStorage.setItem(RATE_KEY, String(state.rate)); } catch (e) { /* ignore */ }
  }

  /* ============================================================
     15. PWA — service worker registration & update flow
     ============================================================
     Goals (per spec):
       • On every page load, check the server for a new SW.
       • If a new SW is found, let it install and call skipWaiting.
       • The new SW claims open clients on activate.
       • Show a small "Update Available" banner; clicking Reload tells
         the waiting worker to skipWaiting, and controllerchange
         auto-reloads the page once it's in control.
       • A first-time user with no prior SW still gets full offline
         support (install event pre-caches the app shell).
     ============================================================ */

  // Banner UI hooks. Declared with `function` so the calls inside
  // the SW .then() block below can resolve it (function declarations
  // are hoisted, const/let would hit a temporal-dead-zone error).
  function showUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    const btn    = document.getElementById('updateReloadBtn');
    if (!banner) return;
    banner.classList.add('show');
    banner.setAttribute('aria-hidden', 'false');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        // Tell the waiting worker to activate. The controllerchange
        // listener below will then reload the page.
        navigator.serviceWorker.getRegistration().then((r) => {
          if (r && r.waiting) {
            r.waiting.postMessage({ type: 'SKIP_WAITING' });
          } else {
            // No waiting worker (e.g. same-version reload).
            // Just reload the page to be sure.
            window.location.reload();
          }
        });
      });
    }
  }

  if ('serviceWorker' in navigator) {
    // `updateViaCache: 'none'` ensures the SW script itself is always
    // fetched from the network, so a redeploy is detected promptly.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // 1) On first load and on every subsequent load, *force* a
        //    server check. The browser only re-checks every ~24h on
        //    its own, which is too slow for a deployed PWA.
        reg.update().catch(() => { /* network blip — ignore */ });

        // 2) Also re-check whenever the tab becomes visible again,
        //    so a user returning to the app picks up updates without
        //    having to close & reopen the browser.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            reg.update().catch(() => { /* ignore */ });
          }
        });

        // 3) If a new SW is already waiting (e.g. user opened a second
        //    tab after the first one updated), show the banner right
        //    away.
        if (reg.waiting) {
          showUpdateBanner();
        }

        // 4) Otherwise, listen for the next install to finish.
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            // "installed" + there's an existing controller = a new
            // version is queued behind the current one. Show the
            // banner so the user can apply it.
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });
      })
      .catch(() => {
        // SW registration is best-effort; offline still works on first load
      });

    // 5) Auto-reload once a new worker has taken control. This fires
    //    when the user clicks Reload (which triggers SKIP_WAITING)
    //    and also when the new worker activates on its own.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  /* ============================================================
     16. INIT
     ============================================================ */
  function init() {
    loadThemePref();
    loadMode();
    loadRate();

    // Reflect restored rate into the rate buttons
    els.rateBtns.forEach((b) => {
      const isActive = parseInt(b.dataset.rate, 10) === state.rate;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    applyTheme();
    applyModeUI();

    // Show the version in the drawer footer
    if (els.drawerVersion) {
      els.drawerVersion.textContent = 'v' + APP_LINKS.appVersion;
    }

    afterChange();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
