/* ============================================================
   文章目录抽屉（CATALOG）
   - 触发：右下角浮动按钮
   - 关闭：X / 遮罩 / Esc / 点击条目
   - 高亮：滚动联动（最后一个越过阅读线的标题）
   - 跳转：带导航栏偏移的平滑滚动
   零依赖，样式见 css/site-2026.css 的「文章目录抽屉」段。
   ============================================================ */
(function () {
  'use strict';

  var root = document.querySelector('[data-fl-toc]');
  var trigger = document.querySelector('[data-fl-toc-open]');
  if (!root || !trigger) return;

  var panel = root.querySelector('.fl-toc-panel');
  var nav = root.querySelector('.fl-toc-nav');
  var links = nav ? Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]')) : [];
  if (!links.length) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var OFFSET = 96;            // 平滑跳转时预留的导航栏高度
  var REVEAL_AT = 180;        // 滚动多少像素后浮出按钮
  var isOpen = false;
  var lastFocus = null;
  var ticking = false;

  /* ---------- 高亮 ---------- */
  var targets = links.map(function (a) {
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    return { link: a, el: id ? document.getElementById(id) : null };
  }).filter(function (t) { return t.el; });

  var current = -1;

  function setActive(index) {
    if (index === current) return;
    current = index;
    targets.forEach(function (t, i) {
      var on = i === index;
      t.link.classList.toggle('is-active', on);
      if (on) t.link.setAttribute('aria-current', 'true');
      else t.link.removeAttribute('aria-current');
    });
  }

  function syncActive() {
    ticking = false;
    var pos = window.scrollY + OFFSET + 8;
    var index = -1;
    for (var i = 0; i < targets.length; i++) {
      var top = targets[i].el.getBoundingClientRect().top + window.scrollY;
      if (top <= pos) index = i;
      else break;
    }
    // 读到文末时，最后一个标题未必越过阅读线，兜底选中末条
    if (index < 0 && window.scrollY > REVEAL_AT) {
      var last = targets[targets.length - 1];
      if (last.el.getBoundingClientRect().top < window.innerHeight * 0.6) index = targets.length - 1;
    }
    setActive(index);
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(syncActive);
    }
    toggleTrigger();
  }

  /* ---------- 浮动按钮显隐 ---------- */
  function toggleTrigger() {
    var show = window.scrollY > REVEAL_AT;
    trigger.classList.toggle('is-visible', show);
    // 避免首屏不可见时仍被 Tab 聚焦
    if (show) trigger.removeAttribute('tabindex');
    else trigger.setAttribute('tabindex', '-1');
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;
    root.hidden = false;
    var gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = gap > 0 ? gap + 'px' : '';
    document.body.classList.add('fl-toc-lock');
    trigger.setAttribute('aria-expanded', 'true');
    // 先上屏再加类，保证过渡生效
    window.requestAnimationFrame(function () {
      root.classList.add('is-open');
      if (nav) nav.focus({ preventScroll: true });
      scrollActiveIntoView();
    });
  }

  function close(restoreFocus) {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('is-open');
    document.body.classList.remove('fl-toc-lock');
    document.body.style.paddingRight = '';
    trigger.setAttribute('aria-expanded', 'false');
    window.setTimeout(function () {
      if (!isOpen) root.hidden = true;
    }, reduceMotion.matches ? 0 : 340);
    if (restoreFocus !== false) {
      var back = lastFocus && document.contains(lastFocus) ? lastFocus : trigger;
      back.focus({ preventScroll: true });
    }
  }

  function scrollActiveIntoView() {
    var active = nav.querySelector('a.is-active') || links[0];
    if (!active) return;
    var box = active.getBoundingClientRect();
    var viewTop = nav.getBoundingClientRect().top;
    if (box.top < viewTop || box.bottom > viewTop + nav.clientHeight) {
      nav.scrollTop += box.top - viewTop - nav.clientHeight / 2 + box.height / 2;
    }
  }

  /* ---------- 跳转 ---------- */
  function jumpTo(hash) {
    var el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.scrollY - OFFSET;
    window.scrollTo({ top: top < 0 ? 0 : top, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    if (history.replaceState) history.replaceState(null, '', hash);
  }

  /* ---------- 事件 ---------- */
  trigger.addEventListener('click', open);

  root.addEventListener('click', function (e) {
    if (e.target.closest('[data-fl-toc-close]')) {
      e.preventDefault();
      close();
    }
  });

  nav.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    var hash = a.getAttribute('href');
    close(false);
    jumpTo(hash);
    setActive(links.indexOf(a));
  });

  document.addEventListener('keydown', function (e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // 抽屉内的 Tab 循环，别跑到底层页面
    if (e.key === 'Tab') {
      var focusables = panel.querySelectorAll('button, a[href]');
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () { if (isOpen) return; syncActive(); });




  // 初始同步（深链进入时直接高亮对应条目）
  toggleTrigger();
  syncActive();
})();
