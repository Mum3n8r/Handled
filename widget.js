/*
 * Handled Chat widget - single embeddable script.
 * Customer embeds: <script src="https://justhandled.net/widget.js" data-client="abc123"></script>
 * That's it. No config file, no login, no OAuth.
 *
 * Backend contract (see chatbot_server.py):
 *   POST /widget/chat  { client_id, messages: [{role, content}, ...], session_id }  -> { reply } | { error }
 *   GET  /widget/health -> { ok: true }
 *
 * Two rendering modes:
 *   1. Floating bubble (default) -- injected into <body>, opens/closes on click. Real customer install.
 *   2. Inline panel               -- if the host page already has an element with id="handled-chat-inline",
 *                                     the widget renders inside it instead. Used by justhandled.net's own
 *                                     landing page for the try-it-live demo panels.
 */
(function () {
  'use strict';

  // -- config resolution ----------------------------------------------------
  // Find the <script> tag that loaded us, read data-* attrs off it.
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) return scripts[i];
    }
    return null;
  })();

  var CLIENT_ID = scriptTag ? scriptTag.getAttribute('data-client') : null;
  var API_BASE  = scriptTag ? scriptTag.getAttribute('data-api')    : null;
  var THEME     = scriptTag ? scriptTag.getAttribute('data-theme')  : null;      // 'light' | 'dark'
  var TITLE     = scriptTag ? scriptTag.getAttribute('data-title')  : null;      // header text override
  var OPENER    = scriptTag ? scriptTag.getAttribute('data-opener') : null;      // first assistant message
  var COLOR     = scriptTag ? scriptTag.getAttribute('data-color')   : null;      // hex brand color e.g. var(--hch-brand)

  if (!API_BASE) {
    // Prod default. Overridable via data-api for local dev / staging.
    API_BASE = 'https://duvet-habitant-stimulate.ngrok-free.dev';
  }
  if (!CLIENT_ID) {
    console.error('[Handled] widget.js loaded without data-client attribute; skipping mount.');
    return;
  }

  // session_id -- stable within one page load, per tab. Used for message threading in Supabase logs.
  var SESSION_ID = 'sess_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var BRAND_COLOR = COLOR || 'var(--hch-brand)'; // resolved after config fetch if no data-color

  // -- rendering target -----------------------------------------------------
  var inlineHost = document.getElementById('handled-chat-inline');
  var mode = inlineHost ? 'inline' : 'floating';

  // -- shared state ---------------------------------------------------------
  var messages = [];                // {role, content} pairs sent to backend
  var proxyAlive = false;
  var opened = mode === 'inline';   // inline mode is always "open"

  // -- style block, scoped by prefix ----------------------------------------
  // Kept minimal on purpose so it inherits typography/colors from the host page's own vars if present.
  var css = [
    '.hch-root, .hch-root *{box-sizing:border-box;font-family:inherit;}',
    '.hch-fab{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:var(--hch-brand);color:#fff;',
      'display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18);',
      'z-index:2147483000;border:0;transition:transform .18s ease,box-shadow .18s ease;}',
    '.hch-fab:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(0,0,0,.24);}',
    '.hch-fab svg{width:26px;height:26px;stroke:#fff;fill:none;stroke-width:2;}',
    '.hch-panel{position:fixed;bottom:96px;right:24px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 128px);',
      'background:#fdfaf6;color:#1e1612;border:1px solid #e0d6cc;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.22);',
      'overflow:hidden;display:flex;flex-direction:column;z-index:2147483000;font-size:14px;}',
    '.hch-panel.hch-inline{position:relative;bottom:auto;right:auto;width:100%;height:100%;box-shadow:none;border-radius:14px;}',
    '.hch-hidden{display:none !important;}',
    '.hch-header{padding:14px 18px;border-bottom:1px solid #e0d6cc;display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '.hch-avatar{width:32px;height:32px;border-radius:50%;background:rgba(212,80,10,.12);border:1px solid rgba(212,80,10,.2);',
      'display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}',
    '.hch-title{font-size:13px;font-weight:700;line-height:1.15;}',
    '.hch-sub{font-size:11px;color:#6b5d52;margin-top:2px;}',
    '.hch-status{width:7px;height:7px;border-radius:50%;background:#15803d;margin-left:auto;box-shadow:0 0 0 3px rgba(21,128,61,.18);}',
    '.hch-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#fdfaf6;scroll-behavior:smooth;}',
    '.hch-messages::-webkit-scrollbar{width:4px;}',
    '.hch-messages::-webkit-scrollbar-thumb{background:#e0d6cc;border-radius:2px;}',
    '.hch-msg{max-width:86%;padding:10px 13px;border-radius:14px;line-height:1.55;font-size:13px;word-wrap:break-word;',
      'animation:hchIn .18s ease;}',
    '@keyframes hchIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}',
    '.hch-msg-ai{background:#f5f0ea;border:1px solid #e0d6cc;color:#1e1612;align-self:flex-start;border-bottom-left-radius:4px;}',
    '.hch-msg-user{background:var(--hch-brand);color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}',
    '.hch-typing{background:#f5f0ea;border:1px solid #e0d6cc;align-self:flex-start;border-bottom-left-radius:4px;padding:13px 15px;}',
    '.hch-dots{display:flex;gap:4px;}',
    '.hch-dots span{width:6px;height:6px;background:#a09082;border-radius:50%;animation:hchBounce 1.2s infinite;}',
    '.hch-dots span:nth-child(2){animation-delay:.15s;}',
    '.hch-dots span:nth-child(3){animation-delay:.3s;}',
    '@keyframes hchBounce{0%,80%,100%{transform:scale(.75);opacity:.4;}40%{transform:scale(1.05);opacity:1;}}',
    '.hch-input-row{padding:12px 14px;border-top:1px solid #e0d6cc;display:flex;gap:8px;align-items:flex-end;background:#fdfaf6;flex-shrink:0;}',
    '.hch-input{flex:1;background:#f5f0ea;border:1px solid #e0d6cc;border-radius:10px;padding:9px 12px;font-size:13px;color:#1e1612;',
      'resize:none;outline:none;max-height:96px;line-height:1.45;font-family:inherit;}',
    '.hch-input:focus{border-color:var(--hch-brand);}',
    '.hch-input::placeholder{color:#a09082;}',
    '.hch-send{width:36px;height:36px;background:var(--hch-brand);border:0;border-radius:10px;cursor:pointer;display:flex;align-items:center;',
      'justify-content:center;flex-shrink:0;transition:background .15s ease,transform .15s ease;}',
    '.hch-send:hover{background:#b84208;transform:translateY(-1px);}',
    '.hch-send:disabled{opacity:.4;cursor:not-allowed;transform:none;}',
    '.hch-send svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.5;}',
    '.hch-footer{padding:8px 14px;border-top:1px solid #e0d6cc;font-size:10.5px;color:#a09082;text-align:center;background:#fdfaf6;flex-shrink:0;}',
    '.hch-footer a{color:#6b5d52;text-decoration:none;}',
    '.hch-footer a:hover{color:#1e1612;}',
  ].join('');

  // Inject brand color as a CSS variable scoped to .hch-root
  var colorStyle = document.createElement('style');
  colorStyle.setAttribute('data-handled-color', '1');
  colorStyle.appendChild(document.createTextNode(
    '.hch-root{--hch-brand:' + BRAND_COLOR + ';--hch-brand-dark:' + BRAND_COLOR + 'cc;}'
  ));
  document.head.appendChild(colorStyle);

  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-handled-chat', '1');
  styleEl.appendChild(document.createTextNode(css));
  document.head.appendChild(styleEl);

  // -- DOM ------------------------------------------------------------------
  var root = document.createElement('div');
  root.className = 'hch-root';

  // Floating action button (skipped in inline mode)
  var fab = null;
  if (mode === 'floating') {
    fab = document.createElement('button');
    fab.className = 'hch-fab';
    fab.setAttribute('aria-label', 'Open chat');
    fab.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    fab.addEventListener('click', function () {
      opened = !opened;
      panel.classList.toggle('hch-hidden', !opened);
      if (opened) {
        setTimeout(function () { input.focus(); }, 50);
        maybeSendOpener();
      }
    });
    root.appendChild(fab);
  }

  var panel = document.createElement('div');
  panel.className = 'hch-panel' + (mode === 'inline' ? ' hch-inline' : ' hch-hidden');
  root.appendChild(panel);

  panel.innerHTML =
    '<div class="hch-header">' +
      '<div class="hch-avatar">' + (mode === 'inline' ? '' : '') + '</div>' +
      '<div>' +
        '<div class="hch-title" data-hch-title>' + (TITLE || 'Chat') + '</div>' +
        '<div class="hch-sub">Powered by Handled</div>' +
      '</div>' +
      '<div class="hch-status" title="Online"></div>' +
    '</div>' +
    '<div class="hch-messages" data-hch-messages></div>' +
    '<div class="hch-input-row">' +
      '<textarea class="hch-input" data-hch-input placeholder="Type a message..." rows="1"></textarea>' +
      '<button class="hch-send" data-hch-send aria-label="Send">' +
        '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>' +
      '</button>' +
    '</div>' +
    '<div class="hch-footer">Powered by <a href="https://justhandled.net" target="_blank" rel="noopener">Handled</a></div>';

  var messagesEl = panel.querySelector('[data-hch-messages]');
  var input      = panel.querySelector('[data-hch-input]');
  var sendBtn    = panel.querySelector('[data-hch-send]');
  var titleEl    = panel.querySelector('[data-hch-title]');

  // Mount:
  if (mode === 'inline') {
    inlineHost.innerHTML = '';
    inlineHost.appendChild(root);
  } else {
    // wait until <body> exists (script may be in <head>)
    if (document.body) {
      document.body.appendChild(root);
    } else {
      document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(root); });
    }
  }

  // -- health check ---------------------------------------------------------
  // Fetch client config (brand color, etc.) unless already set via data-color
  if (!COLOR) {
    fetch(API_BASE + '/widget/config?id=' + CLIENT_ID, {
      method: 'GET',
      headers: { 'ngrok-skip-browser-warning': 'true' },
    }).then(function(r) { return r.ok ? r.json() : null; }).then(function(cfg) {
      if (cfg) {
        if (cfg.brand_color) {
          BRAND_COLOR = cfg.brand_color;
          var cs = document.querySelector('[data-handled-color]');
          if (cs) cs.firstChild.nodeValue = '.hch-root{--hch-brand:' + BRAND_COLOR + ';--hch-brand-dark:' + BRAND_COLOR + 'cc;}';
        }
        if (cfg.opener && !OPENER) { OPENER = cfg.opener; }
        if (cfg.title && !TITLE && titleEl) { titleEl.textContent = cfg.title; }
      }
    }).catch(function() {});
  }

  fetch(API_BASE + '/widget/health', {
    method: 'GET',
    headers: { 'ngrok-skip-browser-warning': 'true' },
  }).then(function (r) {
    proxyAlive = r.ok;
    if (!proxyAlive) showOffline();
  }).catch(function () { showOffline(); });

  function showOffline() {
    messagesEl.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'hch-msg hch-msg-ai';
    el.textContent = 'Chat is temporarily unavailable. Please try again in a moment.';
    messagesEl.appendChild(el);
    input.disabled = true;
    sendBtn.disabled = true;
  }

  // -- interaction ----------------------------------------------------------
  var openerSent = false;
  function maybeSendOpener() {
    if (openerSent || !proxyAlive) return;
    openerSent = true;
    if (OPENER) {
      appendMsg(OPENER, 'ai');
      messages.push({ role: 'assistant', content: OPENER });
    }
  }

  // Inline mode: fire the opener as soon as health check passes (no click gate).
  if (mode === 'inline') {
    var openerInterval = setInterval(function () {
      if (proxyAlive) { clearInterval(openerInterval); maybeSendOpener(); }
    }, 200);
    setTimeout(function () { clearInterval(openerInterval); }, 6000);
  }

  function appendMsg(text, role) {
    var el = document.createElement('div');
    el.className = 'hch-msg ' + (role === 'user' ? 'hch-msg-user' : 'hch-msg-ai');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'hch-msg hch-typing';
    el.setAttribute('data-hch-typing', '1');
    el.innerHTML = '<div class="hch-dots"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function removeTyping() {
    var t = messagesEl.querySelector('[data-hch-typing]');
    if (t) t.parentNode.removeChild(t);
  }

  function send() {
    if (!proxyAlive) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    messages.push({ role: 'user', content: text });
    appendMsg(text, 'user');
    showTyping();

    fetch(API_BASE + '/widget/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        messages: messages,
        session_id: SESSION_ID,
      }),
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; });
    }).then(function (res) {
      removeTyping();
      sendBtn.disabled = false;
      if (!res.ok || res.data.error) {
        appendMsg('Sorry, something went wrong. Please try again.', 'ai');
        return;
      }
      var reply = res.data.reply || '';
      messages.push({ role: 'assistant', content: reply });
      appendMsg(reply, 'ai');
    }).catch(function () {
      removeTyping();
      sendBtn.disabled = false;
      appendMsg('Sorry, something went wrong. Please try again.', 'ai');
    });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 96) + 'px';
  });

  // -- public API for host-page control -------------------------------------
  // Landing page uses these to swap the client_id when the visitor picks a demo tab.
  window.HandledChat = window.HandledChat || {};
  window.HandledChat.setClient = function (newId) {
    if (!newId) return;
    CLIENT_ID = newId;
    messages = [];
    openerSent = false;
    messagesEl.innerHTML = '';
    maybeSendOpener();
  };
  window.HandledChat.setTitle = function (t) {
    if (titleEl) titleEl.textContent = t;
  };
  window.HandledChat.setOpener = function (o) {
    OPENER = o;
    openerSent = false;
  };
  window.HandledChat.open = function () {
    if (mode !== 'floating') return;
    opened = true;
    panel.classList.remove('hch-hidden');
  };
  window.HandledChat.close = function () {
    if (mode !== 'floating') return;
    opened = false;
    panel.classList.add('hch-hidden');
  };
})();
