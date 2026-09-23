/* abrian abir — site behavior. vanilla, no deps. */
(() => {
  'use strict';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

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

  /* ---- mobile menu ------------------------------------------
     Deliberately minimal. Earlier versions locked body scroll
     (position:fixed + overflow:hidden) and hand-rolled the hash
     jump with scrollIntoView + pushState. Both fight the browser:
     changing overflow on a scrolled document makes mobile engines
     recompute the viewport, and a manual scroll racing the native
     hash jump is what produced the "scrolls to top" behaviour.

     So: flip `hidden`, flip `aria-expanded`, and let the browser
     own navigation. Nothing else. -------------------------------- */
  const burger = $('#nav-toggle');
  const mobile = $('#nav-mobile');

  if (burger && mobile) {
    const isOpen = () => burger.getAttribute('aria-expanded') === 'true';

    const setMenu = open => {
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      mobile.hidden = !open;
    };

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
    matchMedia('(min-width: 761px)').addEventListener('change', e => {
      if (e.matches) setMenu(false);
    });
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
  if (reduced) revealables.forEach(el => el.classList.add('in'));
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

  /* ---- rotating headline (typewriter) ----------------------- */
  const hl = $('#headline');
  if (hl) {
    let lines = [];
    try { lines = JSON.parse(hl.dataset.lines || '[]'); } catch {}
    const out = $('#headline-text');
    if (reduced || lines.length < 2) {
      out.textContent = lines[0] || '';
      $('.cursor')?.remove();
    } else {
      let i = 0, j = 0, del = false;
      const tick = () => {
        const s = lines[i];
        j += del ? -1 : 1;
        out.textContent = s.slice(0, j);
        let wait = del ? 18 : 34;
        if (!del && j === s.length) { wait = 2600; del = true; }
        else if (del && j === 0) { del = false; i = (i + 1) % lines.length; wait = 320; }
        setTimeout(tick, wait);
      };
      setTimeout(tick, 550);
    }
  }

  /* ---- card pointer spotlight ------------------------------- */
  if (!reduced && matchMedia('(hover: hover)').matches) {
    $$('.card').forEach(card => {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    });
  }

  /* ---- command palette (Ctrl/⌘ K, or /) --------------------- */
  const pal = $('#palette');
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
  const supportsVT =
    'startViewTransition' in document &&
    CSS.supports('view-transition-name: a') &&
    !reduced;

  if (supportsVT) {
    const slugOf = url => {
      try {
        const m = new URL(url, location.href).pathname.match(/\/projects\/([^/]+)\.html?$/i);
        return m ? m[1] : null;
      } catch { return null; }
    };

    const untag = () => {
      $$('.vt-card').forEach(el => {
        /* the project hero owns the name statically; never strip it */
        if (!el.classList.contains('proj-hero')) el.classList.remove('vt-card');
      });
      $$('.card .vt-title').forEach(el => el.classList.remove('vt-title'));
    };

    const tagCard = slug => {
      untag();
      if (!slug) return false;
      const card = document.querySelector(`.card[data-slug="${CSS.escape(slug)}"]`);
      if (!card) return false;
      card.classList.add('vt-card');
      card.querySelector('h3 a')?.classList.add('vt-title');
      return true;
    };

    addEventListener('pageswap', e => {
      if (!e.viewTransition) return;
      const to = e.activation?.entry?.url;
      const from = e.activation?.from?.url;
      if (!to) return;

      root.dataset.vtDir = slugOf(to) ? 'forward' : 'back';
      if (slugOf(to) && !slugOf(from)) tagCard(slugOf(to));

      /* names must not survive into the bfcache snapshot, or a
         restored page holds a duplicate and kills the next one */
      e.viewTransition.finished.then(untag, untag);
    });

    addEventListener('pagereveal', e => {
      if (!e.viewTransition) { root.removeAttribute('data-vt-arriving'); return; }
      const from = navigation?.activation?.from?.url;
      const here = location.href;

      root.dataset.vtArriving = '';
      root.dataset.vtDir = slugOf(here) ? 'forward' : 'back';

      if (!slugOf(here) && slugOf(from)) tagCard(slugOf(from));

      e.viewTransition.finished.then(() => {
        root.removeAttribute('data-vt-arriving');
        root.removeAttribute('data-vt-dir');
        untag();
      }, () => root.removeAttribute('data-vt-arriving'));
    });

    addEventListener('pagehide', untag);
  }

  /* ---- console note ----------------------------------------- */
  console.log(
    '%c> abrian abir%c\n  built by hand. no framework, no build step at runtime.\n  content lives in /data/site.json — run `python build.py` to regenerate.\n  if you are reading this, we will probably get along.',
    'color:#4FD1C5;font-weight:700;font-family:monospace;font-size:13px',
    'color:#8B949E;font-family:monospace;font-size:12px'
  );
})();
