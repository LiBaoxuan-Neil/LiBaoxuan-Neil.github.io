/* ============================================================
   站内搜索（零依赖）
   - 索引：构建期生成 /search/search-index.json（Hugo 输出格式 SearchIndex）
   - 同一套引擎/样式服务两个入口：
       · 浮层：#fl-search-overlay（任意页面 / 或 Ctrl/⌘+K 唤起）
       · 页面：[data-fl-search-page]（/search/，支持 ?q= 深链）
   - 中文按子串匹配（不做分词），英文按词匹配；先 AND 后 OR 回退
   ============================================================ */
(function () {
  'use strict';

  var configEl = document.querySelector('[data-fl-search-config]');
  var S = {};
  try {
    S = JSON.parse(configEl.textContent || '{}');
    // 某些模板上下文会把 JSON 再包一层字符串，这里兜底解一次
    if (typeof S === 'string') { S = JSON.parse(S); }
  } catch (e) { S = {}; }

  var DEFAULTS = {
    found: '找到 %s 篇文章',
    partial: '没有完全匹配的结果，以下是部分相关内容',
    idleTitle: '输入关键词开始搜索',
    idleDesc: '标题、标签、系列与正文都会被检索。',
    noneTitle: '没有找到「%s」',
    noneDesc: '换个更短的关键词试试。',
    loading: '正在加载索引…',
    error: '索引加载失败，请刷新页面重试。',
    tagsHint: '常用标签',
    minutes: '%s 分钟阅读'
  };
  for (var key in DEFAULTS) {
    if (!S[key]) { S[key] = DEFAULTS[key]; }
  }

  function fmt(tpl, value) {
    return String(tpl).replace('%s', value);
  }

  /* ---------- 文本工具 ---------- */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, function (c) {
      return ESC[c];
    });
  }

  function escapeReg(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 先标记命中位置，再转义 HTML，最后把标记换成 <mark>，
     避免高亮破坏实体（例如关键词 am 命中 &amp; 的边界） */
  function highlight(text, terms) {
    var out = String(text === null || text === undefined ? '' : text);
    var pattern = (terms || [])
      .filter(function (t) { return t; })
      .slice()
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (t) {
        // 词边界用“前后都不是字母”，这样 langchain 仍能命中 langchain4j
        return isWordTerm(t) ? '(?<![a-z])' + escapeReg(t) + '(?![a-z])' : escapeReg(t);
      })
      .join('|');
    if (pattern) {
      try {
        out = out.replace(new RegExp('(' + pattern + ')', 'gi'), '\u0001$1\u0002');
      } catch (e) { /* 关键词含正则怪字符时放弃高亮 */ }
    }
    return escapeHtml(out)
      .replace(/\u0001/g, '<mark class="fl-search-mark">')
      .replace(/\u0002/g, '</mark>');
  }

  function normalize(str) {
    return String(str === null || str === undefined ? '' : str)
      .toLowerCase()
      .replace(/[\u00a0\u3000]/g, ' ');
  }

  /* Hugo 的 .Plain / .Summary 会把引号等转成 &#34; 这类实体，
     索引里再一次性还原，否则摘要会出现 &#34; 字面量 */
  var NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    hellip: '…', mdash: '—', ndash: '–', middot: '·'
  };

  function decodeEntities(str) {
    return String(str).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (match, body) {
      if (body.charAt(0) === '#') {
        var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        return isNaN(code) ? match : String.fromCodePoint(code);
      }
      var named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function decodeDeep(str) {
    var out = decodeEntities(str);
    // 少数内容经过多层转义，最多再解一层
    if (/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/.test(out)) { out = decodeEntities(out); }
    return out;
  }

  /* ---------- 索引 ---------- */
  var indexCache = {};

  function prepare(post) {
    post.title = decodeDeep(post.title);
    post.summary = decodeDeep(post.summary);
    post.text = decodeDeep(post.text);
    post.code = decodeDeep(post.code || '');
    post.series = decodeDeep(post.series);
    post.tags = (post.tags || []).map(function (tag) { return decodeDeep(tag); });
    post._title = normalize(post.title);
    post._summary = normalize(post.summary);
    post._text = normalize(post.text);
    post._code = normalize(post.code);
    post._series = normalize(post.series);
    post._tags = post.tags.map(normalize);
    return post;
  }

  function loadIndex(url) {
    if (!url) { return Promise.reject(new Error('missing index url')); }
    if (!indexCache[url]) {
      indexCache[url] = fetch(url, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          return res.json();
        })
        .then(function (data) {
          var posts = ((data && data.posts) || []).map(prepare);
          indexCache[url] = Promise.resolve(posts);
          return posts;
        })
        .catch(function (err) {
          delete indexCache[url];
          throw err;
        });
    }
    return indexCache[url];
  }

  /* ---------- 检索 ---------- */
  /* 英文/数字关键词按词边界匹配（避免 ai 命中 said、api 命中 rapid），
     中文按子串匹配（不做分词） */
  function isWordTerm(term) {
    return /^[a-z0-9][a-z0-9+#._-]*$/.test(term);
  }

  function matchInfo(haystack, term, cap) {
    if (!haystack) { return { count: 0, index: -1 }; }

    if (!isWordTerm(term)) {
      var first = haystack.indexOf(term);
      if (first === -1) { return { count: 0, index: -1 }; }
      var hits = 0;
      var from = 0;
      var at;
      while ((at = haystack.indexOf(term, from)) !== -1) {
        hits += 1;
        from = at + term.length;
        if (hits >= cap) { break; }
      }
      return { count: hits, index: first };
    }

    var re = new RegExp('(^|[^a-z])(' + escapeReg(term) + ')(?=[^a-z]|$)', 'g');
    var count = 0;
    var index = -1;
    var m;
    while ((m = re.exec(haystack))) {
      count += 1;
      if (index === -1) { index = m.index + m[1].length; }
      if (count >= cap) { break; }
    }
    return { count: count, index: index };
  }

  function scorePost(post, terms) {
    var score = 0;
    var matched = 0;

    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      var hit = false;
      var partial = 0;

      var titleHit = matchInfo(post._title, term, 1);
      if (titleHit.count) {
        partial += 60;
        if (titleHit.index === 0) { partial += 25; }
        hit = true;
      }

      if (matchInfo(post._series, term, 1).count) {
        partial += 18;
        hit = true;
      }

      for (var j = 0; j < post._tags.length; j++) {
        if (matchInfo(post._tags[j], term, 1).count) {
          partial += 22;
          hit = true;
          break;
        }
      }

      if (matchInfo(post._summary, term, 1).count) {
        partial += 12;
        hit = true;
      }

      var inBody = matchInfo(post._text, term, 6).count + matchInfo(post._code, term, 3).count;
      if (inBody) {
        partial += inBody * 3;
        hit = true;
      }

      if (hit) {
        matched += 1;
        score += partial;
      }
    }

    return { score: score, matched: matched };
  }

  function byScore(a, b) {
    return (b._score - a._score) || ((b.ts || 0) - (a.ts || 0));
  }

  function search(posts, raw) {
    var q = normalize(raw).replace(/\s+/g, ' ').trim();
    if (!q) { return null; }

    var terms = [];
    q.split(' ').forEach(function (t) {
      if (t && terms.indexOf(t) === -1) { terms.push(t); }
    });

    var strict = [];
    var loose = [];

    posts.forEach(function (post) {
      var result = scorePost(post, terms);
      if (!result.score) { return; }
      if (result.matched === terms.length) {
        post._score = result.score + (post._title.indexOf(q) !== -1 ? 45 : 0);
        strict.push(post);
      } else {
        post._score = result.score;
        loose.push(post);
      }
    });

    strict.sort(byScore);
    loose.sort(byScore);

    return { query: q, terms: terms, strict: strict, loose: loose, partial: !strict.length && !!loose.length };
  }

  function makeSnippet(post, terms) {
    var text = post.text || '';
    var lower = post._text || '';
    var pos = -1;

    for (var i = 0; i < terms.length; i++) {
      var info = matchInfo(lower, terms[i], 1);
      if (info.index !== -1 && (pos === -1 || info.index < pos)) { pos = info.index; }
    }

    if (pos === -1) {
      var fallback = post.summary || text.slice(0, 170);
      return fallback.length > 180 ? fallback.slice(0, 180) + '…' : fallback;
    }

    var start = Math.max(0, pos - 46);
    var end = Math.min(text.length, pos + 132);
    var frag = text.slice(start, end).replace(/\s+/g, ' ');
    if (start > 0) { frag = '…' + frag; }
    if (end < text.length) { frag += '…'; }
    return frag;
  }

  function topTags(posts, limit) {
    var counts = {};
    posts.forEach(function (post) {
      (post.tags || []).forEach(function (tag) {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); })
      .slice(0, limit)
      .map(function (tag) { return { name: tag, count: counts[tag] }; });
  }

  /* ---------- 渲染 ---------- */
  function chipsHtml(posts, limit) {
    var tags = topTags(posts, limit || 8);
    if (!tags.length) { return ''; }
    var html = tags.map(function (tag) {
      var count = tag.count > 1 ? '<span class="fl-tag-pill-count">' + tag.count + '</span>' : '';
      return '<button type="button" class="fl-tag-pill fl-search-chip" data-fl-search-tag="' +
        escapeHtml(tag.name) + '">' +
        '<span class="fl-tag-pill-name">' + escapeHtml(tag.name) + '</span>' + count +
        '</button>';
    }).join('');
    return '<div class="fl-search-chips">' +
      '<span class="fl-search-chips-label">' + escapeHtml(S.tagsHint) + '</span>' +
      '<div class="fl-search-chips-list">' + html + '</div>' +
      '</div>';
  }

  function itemHtml(post, terms, index) {
    var meta = '<span>' + escapeHtml(post.date) + '</span>';
    if (post.reading) {
      meta += '<span class="fl-meta-dot"></span><span>' + escapeHtml(fmt(S.minutes, post.reading)) + '</span>';
    }

    var tags = post.tags || [];
    // 系列名通常包含标签名（“Kubernetes 核心概念” 与 “Kubernetes”），重复时只留标签
    var seriesRedundant = post.series && tags.some(function (tag) {
      var t = normalize(tag);
      return t && (post._series.indexOf(t) !== -1 || t.indexOf(post._series) !== -1);
    });
    if (post.series && !seriesRedundant) {
      meta += '<span class="fl-meta-dot"></span><span class="fl-search-series">' + escapeHtml(post.series) + '</span>';
    }

    var tags = (post.tags || []).slice(0, 3).map(function (tag) {
      return '<span class="fl-search-tag">' + escapeHtml(tag) + '</span>';
    }).join('<span class="fl-search-tag-sep">·</span>');
    if (tags) {
      tags = '<span class="fl-search-tags">' + tags + '</span>';
    }
    return '<a class="fl-search-item" href="' + escapeHtml(post.url) + '" data-fl-index="' + index + '">' +
      '<h3 class="fl-search-item-title">' + highlight(post.title, terms) + '</h3>' +
      '<p class="fl-search-item-snippet">' + highlight(post._snippet, terms) + '</p>' +
      '<p class="fl-card-meta">' + meta + (tags ? '<span class="fl-meta-dot"></span>' + tags : '') + '</p>' +
      '</a>';
  }

  /* ---------- 控件 ---------- */
  function Box(root, mode) {
    this.root = root;
    this.mode = mode;
    this.indexUrl = root.getAttribute('data-index-url') || '';
    this.input = root.querySelector('[data-fl-search-input]');
    this.body = root.querySelector('[data-fl-search-body]');
    this.status = root.querySelector('[data-fl-search-status]');
    this.clearBtn = root.querySelector('[data-fl-search-clear]');
    this.posts = null;
    this.items = [];
    this.active = -1;
    this.timer = 0;
    this.bind();
  }

  Box.prototype.bind = function () {
    var self = this;

    this.input.addEventListener('input', function () { self.onInput(); });

    this.input.addEventListener('keydown', function (e) { self.onKey(e); });

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', function () {
        self.input.value = '';
        self.onInput();
        self.input.focus();
      });
    }

    this.body.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('[data-fl-search-tag]') : null;
      if (chip) {
        e.preventDefault();
        self.setQuery(chip.getAttribute('data-fl-search-tag'));
      }
    });
  };

  Box.prototype.onInput = function () {
    var self = this;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(function () { self.update(); }, 70);
  };

  Box.prototype.ensure = function () {
    var self = this;
    if (this.posts) { return Promise.resolve(this.posts); }
    if (!this.indexUrl) { return Promise.reject(new Error('missing index url')); }
    return loadIndex(this.indexUrl).then(function (posts) {
      self.posts = posts;
      return posts;
    });
  };

  Box.prototype.update = function () {
    var self = this;
    var query = this.input.value.trim();

    if (this.clearBtn) { this.clearBtn.hidden = !query; }
    this.syncUrl(query);

    if (!query) {
      this.setStatus('');
      if (this.posts) { this.showIdle(); return; }
      this.ensure().then(function () {
        if (!self.input.value.trim()) { self.showIdle(); }
      }).catch(function () { self.showError(); });
      return;
    }

    this.setStatus(S.loading);
    this.ensure().then(function () {
      self.run(query);
    }).catch(function () {
      self.showError();
    });
  };

  Box.prototype.run = function (query) {
    var result = search(this.posts, query);
    if (!result) { this.showIdle(); return; }

    // 有完全匹配（所有词都命中）时只显示完全匹配，避免弱相关结果稀释排序
    var list = (result.strict.length ? result.strict : result.loose).slice(0, 24);

    if (!list.length) {
      this.setStatus('');
      this.showNone(result.query);
      return;
    }

    var html = result.partial
      ? '<p class="fl-search-note">' + escapeHtml(S.partial) + '</p>'
      : '';

    html += '<div class="fl-search-results">';
    list.forEach(function (post, i) {
      post._snippet = makeSnippet(post, result.terms);
      html += itemHtml(post, result.terms, i);
    });
    html += '</div>';

    this.body.innerHTML = html;
    this.items = this.body.querySelectorAll('.fl-search-item');
    this.setActive(this.mode === 'overlay' && this.items.length ? 0 : -1);
    this.setStatus(fmt(S.found, list.length));
  };

  Box.prototype.showIdle = function () {
    this.items = [];
    this.active = -1;
    this.body.innerHTML = '<div class="fl-search-state">' +
      '<p class="fl-search-state-title">' + escapeHtml(S.idleTitle) + '</p>' +
      '<p class="fl-search-state-desc">' + escapeHtml(S.idleDesc) + '</p>' +
      chipsHtml(this.posts || [], 8) +
      '</div>';
  };

  Box.prototype.showNone = function (query) {
    this.items = [];
    this.active = -1;
    this.body.innerHTML = '<div class="fl-search-state">' +
      '<p class="fl-search-state-title">' + escapeHtml(fmt(S.noneTitle, query)) + '</p>' +
      '<p class="fl-search-state-desc">' + escapeHtml(S.noneDesc) + '</p>' +
      chipsHtml(this.posts || [], 6) +
      '</div>';
  };

  Box.prototype.showError = function () {
    this.items = [];
    this.active = -1;
    this.setStatus('');
    this.body.innerHTML = '<div class="fl-search-state fl-search-state--error">' +
      '<p class="fl-search-state-title">' + escapeHtml(S.error) + '</p>' +
      '</div>';
  };

  Box.prototype.setStatus = function (text) {
    if (this.status) { this.status.textContent = text || ''; }
  };

  Box.prototype.setActive = function (index) {
    if (this.active >= 0 && this.items[this.active]) {
      this.items[this.active].classList.remove('is-active');
    }
    this.active = index;
    if (index >= 0 && this.items[index]) {
      var el = this.items[index];
      el.classList.add('is-active');
      if (el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
    }
  };

  Box.prototype.onKey = function (e) {
    var count = this.items.length;

    if (e.key === 'ArrowDown' && count) {
      e.preventDefault();
      this.setActive(this.active + 1 >= count ? 0 : this.active + 1);
      return;
    }

    if (e.key === 'ArrowUp' && count) {
      e.preventDefault();
      this.setActive(this.active - 1 < 0 ? count - 1 : this.active - 1);
      return;
    }

    if (e.key === 'Enter') {
      var target = this.active >= 0 ? this.items[this.active] : this.items[0];
      if (target) {
        e.preventDefault();
        window.location.href = target.getAttribute('href');
      }
      return;
    }

    if (e.key === 'Escape') {
      if (this.mode === 'page' && this.input.value) {
        e.preventDefault();
        this.setQuery('');
      }
    }
  };

  Box.prototype.setQuery = function (value) {
    this.input.value = value;
    this.update();
    this.input.focus({ preventScroll: true });
  };

  Box.prototype.syncUrl = function (query) {
    if (this.mode !== 'page') {
      // 浮层里同步「在搜索页打开」的深链，保留当前关键词
      var link = this.root.querySelector('.fl-search-all');
      if (link) {
        var base = link.getAttribute('data-base') || link.getAttribute('href').split('?')[0];
        link.setAttribute('data-base', base);
        link.href = base + (query ? '?q=' + encodeURIComponent(query) : '');
      }
      return;
    }
    if (!window.history || !history.replaceState) { return; }
    var url = window.location.pathname + (query ? '?q=' + encodeURIComponent(query) : '');
    history.replaceState(null, '', url);
  };

  /* ---------- 浮层 ---------- */
  var overlayRoot = document.querySelector('[data-fl-search-overlay]');
  var pageRoot = document.querySelector('[data-fl-search-page]');
  var overlayBox = null;
  var pageBox = null;
  var overlayOpen = false;
  var lastFocus = null;

  function isTyping(el) {
    if (!el || !el.tagName) { return false; }
    var tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function openOverlay() {
    if (!overlayBox) { return; }
    lastFocus = document.activeElement;
    overlayRoot.hidden = false;
    overlayRoot.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('fl-search-open');
    overlayOpen = true;

    requestAnimationFrame(function () {
      if (overlayOpen) { overlayRoot.classList.add('is-open'); }
    });

    overlayBox.input.focus({ preventScroll: true });
    overlayBox.update();
  }

  function closeOverlay() {
    if (!overlayOpen) { return; }
    overlayOpen = false;
    overlayRoot.classList.remove('is-open');
    document.documentElement.classList.remove('fl-search-open');
    overlayRoot.setAttribute('aria-hidden', 'true');

    window.setTimeout(function () {
      if (!overlayOpen) { overlayRoot.hidden = true; }
    }, 160);

    if (lastFocus && lastFocus.focus) { lastFocus.focus({ preventScroll: true }); }
  }

  function focusPageSearch() {
    if (!pageBox) { return false; }
    if (window.scrollY > 0) { window.scrollTo({ top: 0, behavior: 'smooth' }); }
    pageBox.input.focus({ preventScroll: true });
    pageBox.input.select();
    return true;
  }

  function init() {
    if (overlayRoot) {
      overlayBox = new Box(overlayRoot, 'overlay');

      overlayRoot.querySelectorAll('[data-fl-search-close]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          closeOverlay();
        });
      });

      // 面板内 Tab 循环，避免焦点跑出浮层
      overlayRoot.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') { return; }
        var focusables = overlayRoot.querySelectorAll('input, button, a[href]');
        if (!focusables.length) { return; }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }

    if (pageRoot) {
      pageBox = new Box(pageRoot, 'page');
      var initial = new URLSearchParams(window.location.search).get('q') || '';
      if (initial) { pageBox.input.value = initial; }
      pageBox.update();
    }

    if (pageBox) {
      document.querySelectorAll('[data-fl-search-open]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          focusPageSearch();
        });
      });
    } else if (overlayBox) {
      document.querySelectorAll('[data-fl-search-open]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          openOverlay();
        });
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented) { return; }

      var key = e.key || '';

      if ((e.metaKey || e.ctrlKey) && (key === 'k' || key === 'K')) {
        e.preventDefault();
        if (!focusPageSearch()) { openOverlay(); }
        return;
      }

      if (key === 'Escape' && overlayOpen) {
        e.preventDefault();
        closeOverlay();
        return;
      }

      if (key === '/' && !overlayOpen && !isTyping(e.target)) {
        e.preventDefault();
        if (!focusPageSearch()) { openOverlay(); }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
