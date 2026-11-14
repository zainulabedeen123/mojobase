// Mojobase Docs runtime: navigation drawer, collapsible groups, tabs, copy
// buttons, table-of-contents highlighting and client-side search.
// Loaded as an external, deferred script (the console CSP forbids inline JS).
(function () {
  'use strict';

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  // ------------------------------------------------------------ drawer
  var sidebar = $('#sidebar');
  var scrim = $('.scrim');
  var menuBtn = $('[data-drawer-open]');
  function setDrawer(open) {
    if (!sidebar) return;
    sidebar.classList.toggle('open', open);
    if (scrim) scrim.hidden = !open;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('no-scroll', open);
    if (open) {
      var active = $('.nav-link.active', sidebar);
      if (active) active.scrollIntoView({ block: 'center' });
      var closeBtn = $('.sidebar-head [data-drawer-close]', sidebar);
      if (closeBtn) closeBtn.focus();
    } else if (menuBtn && document.activeElement && sidebar.contains(document.activeElement)) {
      menuBtn.focus();
    }
  }
  if (menuBtn)
    menuBtn.addEventListener('click', function () {
      setDrawer(true);
    });
  $$('[data-drawer-close]').forEach(function (el) {
    el.addEventListener('click', function () {
      setDrawer(false);
    });
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 960 && sidebar && sidebar.classList.contains('open')) setDrawer(false);
  });

  // keep the active page visible in the desktop sidebar
  var activeLink = sidebar && $('.nav-link.active', sidebar);
  if (activeLink && window.innerWidth > 960) {
    var r = activeLink.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 40) sidebar.scrollTop += r.top - window.innerHeight / 3;
  }

  // ------------------------------------------------------------ nav groups
  $$('.nav-group-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var list = document.getElementById(btn.getAttribute('aria-controls'));
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      if (list) list.hidden = !open;
    });
  });

  // ------------------------------------------------------------ tabs
  $$('[data-tabs]').forEach(function (tabs) {
    var buttons = $$(':scope > .tab-list > .tab', tabs);
    var panels = $$(':scope > .tab-panel', tabs);
    function select(i, focus) {
      buttons.forEach(function (b, k) {
        var on = k === i;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (panels[k]) panels[k].hidden = !on;
      });
      if (focus) buttons[i].focus();
    }
    buttons.forEach(function (b, i) {
      b.addEventListener('click', function () {
        select(i, false);
      });
      b.addEventListener('keydown', function (e) {
        var n = buttons.length;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          select((i + 1) % n, true);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          select((i - 1 + n) % n, true);
        } else if (e.key === 'Home') {
          e.preventDefault();
          select(0, true);
        } else if (e.key === 'End') {
          e.preventDefault();
          select(n - 1, true);
        }
      });
    });
  });

  // ------------------------------------------------------------ copy buttons
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) resolve();
        else reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      }
      document.body.removeChild(ta);
    });
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.copy-btn');
    if (!btn) return;
    var block = btn.closest('.code-block');
    var code = block && $('pre code', block);
    if (!code) return;
    copyText(code.textContent.replace(/\n$/, '')).then(
      function () {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1600);
      },
      function () {
        btn.textContent = 'Press Ctrl+C';
      }
    );
  });

  // ------------------------------------------------------------ TOC highlight
  var tocLinks = $$('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    tocLinks.forEach(function (a) {
      map[decodeURIComponent(a.getAttribute('href').slice(1))] = a;
    });
    var visible = {};
    var headings = Object.keys(map)
      .map(function (id) {
        return document.getElementById(id);
      })
      .filter(Boolean);
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          visible[en.target.id] = en.isIntersecting;
        });
        var current = null;
        for (var i = 0; i < headings.length; i++) {
          if (visible[headings[i].id]) {
            current = headings[i].id;
            break;
          }
        }
        if (!current) {
          for (var j = headings.length - 1; j >= 0; j--) {
            if (headings[j].getBoundingClientRect().top < 120) {
              current = headings[j].id;
              break;
            }
          }
        }
        tocLinks.forEach(function (a) {
          a.classList.remove('active');
        });
        if (current && map[current]) map[current].classList.add('active');
      },
      { rootMargin: '-60px 0px -60% 0px' }
    );
    headings.forEach(function (h) {
      io.observe(h);
    });
  }

  // ------------------------------------------------------------ search
  var modal = $('[data-search-modal]');
  var input = modal && $('.search-input', modal);
  var list = modal && $('.search-results', modal);
  var index = null;
  var loading = null;
  var results = [];
  var selected = 0;
  var lastFocus = null;

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;
    loading = fetch('/docs/search-index.json', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        index = data.map(function (p) {
          p._t = p.t.toLowerCase();
          p._h = p.h
            .map(function (h) {
              return h[0].toLowerCase();
            })
            .join(' \u0001 ');
          p._d = (p.d || '').toLowerCase();
          p._x = (p.x || '').toLowerCase();
          return p;
        });
        return index;
      });
    loading.catch(function () {
      loading = null;
    });
    return loading;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function highlight(text, terms) {
    var out = esc(text);
    terms.forEach(function (t) {
      if (t.length < 2) return;
      var re = new RegExp('(' + esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }
  function snippet(p, terms) {
    var x = p.x || '';
    var lx = p._x;
    var pos = -1;
    for (var i = 0; i < terms.length && pos < 0; i++) pos = lx.indexOf(terms[i]);
    if (pos < 0) return p.d || x.slice(0, 160);
    var start = Math.max(0, pos - 60);
    return (start > 0 ? '…' : '') + x.slice(start, start + 180) + '…';
  }

  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) return [];
    var scored = [];
    index.forEach(function (p) {
      var score = 0;
      var anchor = null;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var s = 0;
        if (p._t.indexOf(t) >= 0) s += p._t.indexOf(t) === 0 ? 14 : 10;
        if (p._h.indexOf(t) >= 0) {
          s += 5;
          if (!anchor) {
            for (var k = 0; k < p.h.length; k++) {
              if (p.h[k][0].toLowerCase().indexOf(t) >= 0) {
                anchor = p.h[k];
                break;
              }
            }
          }
        }
        if (p._d.indexOf(t) >= 0) s += 3;
        if (p._x.indexOf(t) >= 0) s += 1 + Math.min(3, p._x.split(t).length - 1) * 0.5;
        if (!s) return; // every term must match somewhere
        score += s;
      }
      if (p._t.indexOf(q.toLowerCase()) >= 0) score += 8;
      scored.push({ p: p, score: score, anchor: anchor });
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, 12).map(function (r) {
      return { p: r.p, anchor: r.anchor, terms: terms };
    });
  }

  function render(q) {
    if (!list) return;
    if (!q.trim()) {
      list.innerHTML = '<li class="search-empty">Type to search the docs</li>';
      results = [];
      return;
    }
    results = search(q);
    selected = 0;
    if (!results.length) {
      list.innerHTML = '<li class="search-empty">No results for “' + esc(q) + '”</li>';
      return;
    }
    list.innerHTML = results
      .map(function (r, i) {
        var href = r.p.u + (r.anchor ? '#' + r.anchor[1] : '');
        var title = r.p.t + (r.anchor ? ' › ' + r.anchor[0] : '');
        return (
          '<li role="option" aria-selected="' +
          (i === 0) +
          '"><a href="' +
          esc(href) +
          '"' +
          (i === 0 ? ' class="selected"' : '') +
          '>' +
          (r.p.g ? '<span class="sr-group">' + esc(r.p.g) + '</span>' : '') +
          '<span class="sr-title">' +
          highlight(title, r.terms) +
          '</span>' +
          '<span class="sr-snippet">' +
          highlight(snippet(r.p, r.terms), r.terms) +
          '</span></a></li>'
        );
      })
      .join('');
  }

  function move(delta) {
    var links = $$('a', list);
    if (!links.length) return;
    selected = (selected + delta + links.length) % links.length;
    links.forEach(function (a, i) {
      a.classList.toggle('selected', i === selected);
      a.parentNode.setAttribute('aria-selected', String(i === selected));
    });
    links[selected].scrollIntoView({ block: 'nearest' });
  }

  function openSearch() {
    if (!modal) return;
    if (sidebar && sidebar.classList.contains('open')) setDrawer(false);
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('no-scroll');
    input.value = '';
    render('');
    input.focus();
    loadIndex().then(
      function () {
        render(input.value);
      },
      function () {
        list.innerHTML = '<li class="search-empty">Search is unavailable right now.</li>';
      }
    );
  }
  function closeSearch() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('no-scroll');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (modal) {
    $$('[data-search-open]').forEach(function (b) {
      b.addEventListener('click', openSearch);
    });
    $$('[data-search-close]', modal).forEach(function (b) {
      b.addEventListener('click', closeSearch);
    });
    input.addEventListener('input', function () {
      render(input.value);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        var a = $$('a', list)[selected];
        if (a) {
          e.preventDefault();
          closeSearch();
          window.location.href = a.href;
        }
      }
    });
    list.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeSearch();
    });
  }

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (modal && !modal.hidden) closeSearch();
      else openSearch();
    } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape') {
      if (modal && !modal.hidden) closeSearch();
      else if (sidebar && sidebar.classList.contains('open')) setDrawer(false);
    }
  });
})();
