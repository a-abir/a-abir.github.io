/* abrian abir — site behavior. vanilla, no deps. */
(() => {
  'use strict';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;

  /* Live query, not a one-shot boolean. iOS users toggle Reduce Motion
     mid-session, and a cached `true` from load time silently disables
     things forever. Read `.matches` at the moment of use. */
  const rmq = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => rmq.matches;

  /* Safari <14 lacks addEventListener on MediaQueryList. */
  const onMQ = (mq, fn) =>
    mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn);

  /* ---- theme ------------------------------------------------ */
  const setTheme = t => {
    root.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch {}
    $('#theme-toggle')?.setAttribute('aria-label', `Switch to ${t === 'dark' ? 'light' : 'dark'} theme`);
  };
  $('#theme-toggle')?.addEventListener('click', () =>
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

  /* ---- sticky nav + reading progress ------------------------ */
  const nav = $('.nav'), bar = $('.progress');
  const onScroll = () => {
    if (nav) nav.dataset.scrolled = window.scrollY > 8;
    if (bar) {
      const h = document.body.scrollHeight - innerHeight;
      bar.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + '%';
    }
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- mobile menu ------------------------------------------*/
  const burger = $('#nav-toggle');
  const mobile = $('#nav-mobile');

  /* Exposed so the view-transition code can force overlays shut
     before the outgoing snapshot is taken. */
  let closeMenu = () => {};

  if (burger && mobile) {
    const isOpen = () => burger.getAttribute('aria-expanded') === 'true';

    const setMenu = open => {
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      mobile.hidden = !open;
    };
    closeMenu = () => setMenu(false);

    burger.addEventListener('click', () => setMenu(!isOpen()));

    /* A link closes the panel. Same-page hashes don't unload the
       document, so without this it would sit open over the target.
       No preventDefault — the browser still does the scrolling. */
    mobile.addEventListener('click', e => {
      if (e.target.closest('a')) setMenu(false);
    });

    addEventListener('keydown', e => {
      if (!isOpen()) return;

      if (e.key === 'Escape') {
        setMenu(false);
        burger.focus();
        return;
      }
      if (e.key !== 'Tab') return;

      /* keep tabbing inside the panel while it's open */
      const f = [burger, ...$$('a', mobile)];
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    /* close on outside tap */
    document.addEventListener('click', e => {
      if (!isOpen()) return;
      if (!e.target.closest('#nav-mobile') && !e.target.closest('#nav-toggle')) setMenu(false);
    });

    /* never leave it open across a restore or past the breakpoint */
    addEventListener('pageshow', () => setMenu(false));
    onMQ(matchMedia('(min-width: 761px)'), e => { if (e.matches) setMenu(false); });
  }

  /* ---- scroll spy (main nav + mobile panel + project TOC) ---- */
  const spy = linkSel => {
    const links = $$(linkSel).filter(a => a.hash && $(a.hash));
    if (!links.length) return;
    const map = new Map(links.map(a => [$(a.hash), a]));
    const seen = new Set();
    const io = new IntersectionObserver(es => {
      es.forEach(e => e.isIntersecting ? seen.add(e.target) : seen.delete(e.target));
      const first = [...map.keys()].find(t => seen.has(t));
      links.forEach(a => a.removeAttribute('aria-current'));
      if (first) map.get(first).setAttribute('aria-current', 'true');
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    map.forEach((_, t) => io.observe(t));
  };
  spy('.nav__links a');
  spy('.nav__mobile a');
  spy('.toc a');

  /* ---- reveal on scroll ------------------------------------- */
  const revealables = $$('.reveal');
  /* Anything already in the viewport is revealed synchronously —
     otherwise a view-transition snapshot taken on arrival can
     freeze an empty page into the animation. */
  revealables.forEach(el => {
    if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
  });
  if (reduced()) revealables.forEach(el => el.classList.add('in'));
  else {
    const ro = new IntersectionObserver((es, obs) => {
      es.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        obs.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    revealables.forEach(el => ro.observe(el));
  }

  /* ---- headline --------------------------------------------- */
  const hl = $('#headline');
  if (hl) {
    let lines = [];
    try { lines = JSON.parse(hl.dataset.lines || '[]'); } catch { }

    const out = $('#headline-text', hl);
    if (out && lines.length) {
      const KEY = 'headline:i';
      let i = 0;
      try {
        i = (parseInt(localStorage.getItem(KEY), 10) || 0) % lines.length;
        localStorage.setItem(KEY, String((i + 1) % lines.length));
      } catch {
        i = Math.floor(Math.random() * lines.length);
      }
      out.textContent = lines[i];
    } else if (out) {
      out.textContent = '';
    }

    $('.cursor', hl)?.remove();
  }
  /* ---- card pointer spotlight ------------------------------- */
  if (!reduced() && matchMedia('(hover: hover)').matches) {
    $$('.card').forEach(card => {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
      card.addEventListener('pointerenter', () => {
        card.style.borderColor = 'var(--border-strong)';
        card.style.transform = 'translateY(-3px)';
        card.style.boxShadow = 'var(--shadow)';
      });
      card.addEventListener('pointerleave', () => {
        card.style.borderColor = '';
        card.style.transform = '';
        card.style.boxShadow = '';
      });
    });
  }

  /* ---- command palette (Ctrl/⌘ K, or /) --------------------- */
  const pal = $('#palette');
  let closePalette = () => {};
  if (pal) {
    const input = $('#palette-input');
    const list  = $('#palette-list');
    const items = $$('li', list);
    let empty = null;

    const visible = () => items.filter(li => !li.hidden);
    const clearActive = () => $$('a.is-active', list).forEach(a => a.classList.remove('is-active'));

    const open = () => {
      if (pal.open) return;
      pal.showModal();
      input.value = '';
      items.forEach(li => li.hidden = false);
      empty?.remove(); empty = null;
      clearActive();
      input.focus();
    };
    const close = () => pal.open && pal.close();
    closePalette = close;

    $$('[data-open-palette]').forEach(b => b.addEventListener('click', open));

    addEventListener('keydown', e => {
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.open ? close() : open(); }
      else if (e.key === '/' && !typing && !pal.open) { e.preventDefault(); open(); }
    });

    /* --- dismiss on outside click ---------------------------
       A <dialog> box covers the whole viewport because of inset:0,
       so `e.target === pal` is not reliable alone. Hit-test the
       pointer against the actual .pal__box rect. */
    pal.addEventListener('pointerdown', e => {
      const box = $('.pal__box', pal).getBoundingClientRect();
      const outside =
        e.clientX < box.left || e.clientX > box.right ||
        e.clientY < box.top  || e.clientY > box.bottom;
      if (outside) close();
    });
    pal.addEventListener('click', e => { if (e.target === pal) close(); });

    /* filter */
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      items.forEach(li => li.hidden = q && !li.textContent.toLowerCase().includes(q));
      clearActive();
      const none = visible().length === 0;
      if (none && !empty) {
        empty = document.createElement('p');
        empty.className = 'pal__empty';
        empty.textContent = 'no match. try fewer letters.';
        list.after(empty);
      } else if (!none && empty) { empty.remove(); empty = null; }
    });

    /* --- close when a result is chosen ---------------------
       A <dialog> does not close itself when a link inside it is
       activated. Cross-document links unload the page anyway; a
       same-page hash does not, so the panel would sit open over
       the target. Just close and let the browser navigate. */
    list.addEventListener('click', e => {
      if (e.target.closest('a')) close();
    });

    /* keyboard nav */
    const move = dir => {
      const links = visible().map(li => $('a', li));
      if (!links.length) return;
      const cur = links.findIndex(a => a.classList.contains('is-active'));
      const next = dir > 0 ? (cur + 1) % links.length : (cur <= 0 ? links.length - 1 : cur - 1);
      clearActive();
      links[next].classList.add('is-active');
      links[next].scrollIntoView({ block: 'nearest' });
    };
    pal.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        ($('a.is-active', list) || $('a', visible()[0] || document.createElement('li')))?.click();
      }
    });
    pal.addEventListener('close', () => { clearActive(); empty?.remove(); empty = null; });
  }

  /* ---- cross-document view transitions ----------------------
     CSS handles the root cross-fade. This does the one thing CSS
     cannot: decide WHICH card is the shared element, since a
     view-transition-name must be unique per document.

     Requires an http(s) origin. Inert on file:// and where
     cross-document transitions aren't supported. ---------------- */

  /* Feature test, not a motion test. Reduce Motion is checked per
     navigation instead — baking it into this constant is what made
     the whole feature vanish on phones, where Reduce Motion is
     commonly enabled. CSS already tones the animation down. */
  const supportsVT =
    'startViewTransition' in document &&
    typeof CSS !== 'undefined' &&
    CSS.supports('view-transition-name: a');

  if (supportsVT) {
    const KEY = 'vt:from-slug';

    const slugOf = url => {
      try {
        const m = new URL(url, location.href).pathname.match(/\/projects\/([^/]+)\.html?$/i);
        return m ? m[1] : null;
      } catch { return null; }
    };

    /* The slug of THIS page, straight from the DOM. `.proj-hero`
       already carries data-slug, so the return trip never has to ask
       the Navigation API — which does not exist in Safari, and was
       why the shared element only appeared in Chromium. */
    const hereSlug = () => $('.proj-hero')?.dataset.slug || slugOf(location.href);

    const stash = v => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} };
    const unstash = () => { try { const v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return v; } catch { return null; } };

    const untag = () => {
      $$('.vt-card').forEach(el => {
        /* the project hero owns the name statically; never strip it */
        if (!el.classList.contains('proj-hero')) el.classList.remove('vt-card');
      });
      $$('.card .vt-title').forEach(el => el.classList.remove('vt-title'));
    };

    /* A named element outside the viewport animates from nowhere
       visible, which reads as "the transition didn't run". */
    const inViewport = el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const vh = innerHeight || root.clientHeight;
      const vw = innerWidth  || root.clientWidth;
      const visY = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const visX = Math.min(r.right, vw) - Math.max(r.left, 0);
      return visY > Math.min(r.height * 0.35, 80) && visX > 0;
    };

    const tagCard = slug => {
      untag();
      if (!slug) return false;
      const card = document.querySelector(`.card[data-slug="${CSS.escape(slug)}"]`);
      if (!card || !inViewport(card)) return false;
      card.classList.add('vt-card');
      card.querySelector('h3 a')?.classList.add('vt-title');
      return true;
    };

    /* --- fragment arrivals ----------------------------------
       "← all projects" points at index.html#projects. That is a
       FORWARD navigation carrying a hash, and the browser applies
       the fragment scroll only AFTER pagereveal. So at snapshot
       time the document is still at scroll 0: the card grid is
       thousands of pixels away, inViewport() rejects it, and the
       fragment scroll then fires mid-animation against a root
       snapshot pinned at the old offset — which is the jump.

       Landing the scroll here, synchronously and without smooth
       behaviour, puts the page in its final position before the
       snapshot is taken. Browser Back is unaffected because scroll
       restoration has already run by this point. */
    const settleFragment = () => {
      const id = location.hash;
      if (!id || id === '#') return;
      let target = null;
      try { target = document.querySelector(id); } catch { return; }
      if (!target) return;
      const prev = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      target.scrollIntoView({ block: 'start' });
      root.style.scrollBehavior = prev;
    };

    /* Overlays must not be in the outgoing snapshot. Closing them in
       the link's own click handler races the capture; doing it here
       is synchronous and guaranteed to land first. */
    const shutOverlays = () => { try { closeMenu(); closePalette(); } catch {} };

    addEventListener('pageswap', e => {
      if (!e.viewTransition) { stash(null); return; }
      if (reduced()) { e.viewTransition.skipTransition(); untag(); stash(null); return; }

      shutOverlays();

      const to   = e.activation?.entry?.url || location.href;
      const from = hereSlug();

      /* Hand the origin slug to the next document. e.activation is
         Chromium-only on the receiving side, and Safari has no
         Navigation API at all, so this is the portable channel. */
      stash(!slugOf(to) && from ? from : null);

      root.dataset.vtDir = slugOf(to) ? 'forward' : 'back';
      if (slugOf(to) && !from) tagCard(slugOf(to));

      /* names must not survive into the bfcache snapshot, or a
         restored page holds a duplicate and kills the next one */
      e.viewTransition.finished.then(untag, untag);
    });

    addEventListener('pagereveal', e => {
      if (!e.viewTransition) { root.removeAttribute('data-vt-arriving'); unstash(); return; }
      if (reduced()) {
        e.viewTransition.skipTransition();
        root.removeAttribute('data-vt-arriving');
        root.removeAttribute('data-vt-dir');
        untag(); unstash();
        return;
      }

      const here = hereSlug();
      const from = unstash();

      root.dataset.vtArriving = '';
      root.dataset.vtDir = here ? 'forward' : 'back';

      /* order matters: scroll first, then measure, then tag */
      if (!here) {
        settleFragment();
        if (from) tagCard(from);
      }

      const cleanup = () => {
        root.removeAttribute('data-vt-arriving');
        root.removeAttribute('data-vt-dir');
        untag();
      };
      e.viewTransition.finished.then(cleanup, () => root.removeAttribute('data-vt-arriving'));

      /* Safety net: if `finished` never settles (a skipped or
         interrupted transition on a backgrounded tab — common when
         a phone locks mid-navigation) the page would stay stuck in
         its arriving state with pointer-events or opacity pinned. */
      setTimeout(cleanup, 1200);
    });

    addEventListener('pagehide', () => { untag(); shutOverlays(); });
  }

  /* ---- console note ----------------------------------------- */
  console.log(
    '%c> abrian abir%c\n  built by hand. no framework, no build step at runtime.\n  content lives in /data/site.json — run `python build.py` to regenerate.\n  if you are reading this, we will probably get along.',
    'color:#4FD1C5;font-weight:700;font-family:monospace;font-size:13px',
    'color:#8B949E;font-family:monospace;font-size:12px'
  );
})();
