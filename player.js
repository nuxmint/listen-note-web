// Article reader with audio controls and sentence highlight. Used by the Mac preview and the iPhone app.
(function () {
  const SPEEDS = [0.75, 0.9, 1, 1.15, 1.25, 1.5];
  const SPEED_KEY = 'listen-note-speed';
  const REPEAT_KEY = 'listen-note-repeat';
  // "Sentence" is never remembered: a new text would otherwise loop its first sentence.
  const REPEATS = [['one', '본문 반복'], ['sentence', '문장 반복'], ['off', '반복 끔']];
  const ICONS = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
    back: '<path d="M12.5 3a9 9 0 1 1-8.94 10h2.02a7 7 0 1 0 1.6-5.6L10 10H3V3l2.75 2.75A8.97 8.97 0 0 1 12.5 3z"/><text x="12.5" y="15.6" text-anchor="middle" font-size="7" font-weight="700" font-family="-apple-system,sans-serif">15</text>',
    forward: '<path d="M11.5 3a9 9 0 1 0 8.94 10h-2.02a7 7 0 1 1-1.6-5.6L14 10h7V3l-2.75 2.75A8.97 8.97 0 0 0 11.5 3z"/><text x="11.5" y="15.6" text-anchor="middle" font-size="7" font-weight="700" font-family="-apple-system,sans-serif">15</text>',
    prev: '<path d="M6 5h2v14H6zM9.5 12 19 5v14z"/>',
    next: '<path d="M16 5h2v14h-2zM14.5 12 5 19V5z"/>',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${ICONS[name]}</svg>`;
  }

  function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
  }

  function button(name, label, className = '') {
    const node = el('button', `player-button ${className}`.trim());
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.innerHTML = icon(name);
    return node;
  }

  function savedSpeed() {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(value) ? value : 1;
  }

  // Index of the segment playing at time t: the last one that has started.
  function segmentAt(segments, t) {
    let low = 0;
    let high = segments.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (segments[middle].start <= t + 0.05) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  function mount(container, options) {
    const { article, src } = options;
    const segments = article.segments || [];
    container.replaceChildren();
    container.classList.add('reader');

    // The phone passes one audio element for every text, so iOS keeps playing from one to the next.
    const shared = Boolean(options.audio);
    const audio = options.audio || new Audio();
    const off = new AbortController();
    const listen = { signal: off.signal };
    audio.preload = 'auto';
    audio.src = src;
    audio.defaultPlaybackRate = savedSpeed();
    audio.playbackRate = audio.defaultPlaybackRate;

    // Text: the title and every body sentence are tappable spans that seek to their start.
    const header = el('header', 'reader-head');
    const title = el('h1', 'reader-title');
    const meta = el('p', 'reader-meta');
    header.append(title, meta);
    const body = el('div', 'reader-body');
    const spans = [];
    let paragraph = null;
    let paragraphNumber = null;
    segments.forEach((segment, index) => {
      let span;
      if (segment.kind === 'title') {
        // The current title is shown even if it was edited after the audio was made.
        span = el('span', 'seg', article.title || segment.text);
        title.append(span);
      } else if (segment.kind === 'source') {
        span = el('span', 'seg seg-source', segment.text.replace(/^From\s+|\.$/g, ''));
        meta.prepend(span);
      } else {
        if (segment.para !== paragraphNumber) {
          paragraph = el('p');
          body.append(paragraph);
          paragraphNumber = segment.para;
        } else {
          paragraph.append(' ');
        }
        span = el('span', 'seg', segment.text);
        paragraph.append(span);
      }
      span.dataset.index = index;
      spans.push(span);
    });
    if (!title.textContent) title.textContent = article.title || '제목 없음';
    const spokenSource = segments.some((segment) => segment.kind === 'source');
    const details = [spokenSource ? '' : article.source, article.author, article.published, clock(article.duration)].filter(Boolean);
    meta.append(el('span', 'reader-detail', (meta.childNodes.length ? ' · ' : '') + details.join(' · ')));
    if (article.url) {
      const link = el('a', 'reader-link', '웹페이지 열기');
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      meta.append(' ', link);
    }

    // Controls stay at the bottom of the screen.
    const bar = el('div', 'player-bar');
    const seek = el('input', 'player-seek');
    seek.type = 'range';
    seek.min = 0;
    seek.max = Math.max(1, article.duration || 1);
    seek.step = 0.1;
    seek.value = 0;
    seek.setAttribute('aria-label', '재생 위치');
    const times = el('div', 'player-times');
    const elapsed = el('span', 'player-time', '0:00');
    const total = el('span', 'player-time', clock(article.duration));
    const chips = el('div', 'player-chips');
    const row = el('div', 'player-row');
    const speed = el('button', 'player-speed');
    speed.type = 'button';
    speed.title = '재생 속도';
    const prev = button('prev', '이전 문장');
    const back = button('back', '15초 뒤로');
    const play = button('play', '재생', 'player-main');
    const forward = button('forward', '15초 앞으로');
    const next = button('next', '다음 문장');
    // The three repeat choices are all visible; the one in use is filled in.
    const repeats = el('div', 'player-repeats');
    repeats.setAttribute('role', 'group');
    repeats.setAttribute('aria-label', '반복');
    REPEATS.forEach(([mode, label]) => {
      const choice = el('button', 'player-repeat', label);
      choice.type = 'button';
      choice.dataset.mode = mode;
      repeats.append(choice);
    });
    chips.append(speed);
    times.append(elapsed, chips, total);
    row.append(prev, back, play, forward, next);
    bar.append(seek, times, repeats, row);
    container.append(header, body, bar);

    let current = -1;
    let userScrollUntil = 0;
    let frame = 0;
    let dragging = false;
    let repeatMode = localStorage.getItem(REPEAT_KEY) === 'one' ? 'one' : 'off';
    let repeatIndex = -1;

    function showSpeed() {
      speed.textContent = `${audio.playbackRate}×`;
    }
    showSpeed();

    function showRepeat() {
      repeats.querySelectorAll('.player-repeat').forEach((choice) => {
        choice.setAttribute('aria-pressed', String(choice.dataset.mode === repeatMode));
      });
    }
    showRepeat();

    // Sentence repeat: once playback passes the end of the chosen sentence, go back to its start.
    function checkRepeat() {
      const segment = repeatMode === 'sentence' && segments[repeatIndex];
      if (segment && audio.currentTime > segment.end + 0.03) audio.currentTime = segment.start;
    }

    function highlight(index) {
      if (index === current) return;
      if (spans[current]) spans[current].classList.remove('now');
      current = index;
      const span = spans[index];
      if (!span) return;
      span.classList.add('now');
      if (Date.now() > userScrollUntil) {  // the highlighted sentence is always kept in view
        const box = span.getBoundingClientRect();
        const barTop = bar.getBoundingClientRect().top;
        if (box.top < 60 || box.bottom > barTop - 40) {
          span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }

    function tick() {
      checkRepeat();
      if (!dragging) seek.value = audio.currentTime;
      elapsed.textContent = clock(audio.currentTime);
      highlight(segmentAt(segments, audio.currentTime));
      if (options.onPosition) options.onPosition(audio.currentTime, audio.duration || article.duration);
    }

    function loop() {
      tick();
      frame = audio.paused ? 0 : requestAnimationFrame(loop);
    }

    function jumpTo(seconds) {
      const end = audio.duration || article.duration || 0;
      audio.currentTime = Math.max(0, Math.min(seconds, Math.max(0, end - 0.1)));
      tick();
    }

    function sentence(step) {
      const now = segmentAt(segments, audio.currentTime);
      // "Previous" first returns to the start of the current sentence, like a music player.
      let target = now + step;
      if (step < 0 && now >= 0 && audio.currentTime - segments[now].start > 1.5) target = now;
      target = Math.max(0, Math.min(segments.length - 1, target));
      if (!segments[target]) return;
      if (repeatMode === 'sentence') repeatIndex = target;
      jumpTo(segments[target].start);
    }

    function toggle() {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    }

    play.addEventListener('click', toggle);
    repeats.addEventListener('click', (event) => {
      const choice = event.target.closest('.player-repeat');
      if (!choice) return;
      repeatMode = choice.dataset.mode;
      repeatIndex = Math.max(0, segmentAt(segments, audio.currentTime));
      localStorage.setItem(REPEAT_KEY, repeatMode === 'one' ? 'one' : 'off');
      showRepeat();
    });
    back.addEventListener('click', () => jumpTo(audio.currentTime - 15));
    forward.addEventListener('click', () => jumpTo(audio.currentTime + 15));
    prev.addEventListener('click', () => sentence(-1));
    next.addEventListener('click', () => sentence(1));
    speed.addEventListener('click', () => {
      const index = SPEEDS.indexOf(audio.playbackRate);
      audio.playbackRate = SPEEDS[(index + 1) % SPEEDS.length];
      audio.defaultPlaybackRate = audio.playbackRate;
      localStorage.setItem(SPEED_KEY, String(audio.playbackRate));
      showSpeed();
    });
    seek.addEventListener('input', () => {
      dragging = true;
      elapsed.textContent = clock(Number(seek.value));
    });
    seek.addEventListener('change', () => {
      dragging = false;
      jumpTo(Number(seek.value));
    });
    container.addEventListener('click', (event) => {
      const span = event.target.closest('.seg');
      if (!span || !container.contains(span)) return;
      if (repeatMode === 'sentence') repeatIndex = Number(span.dataset.index);
      jumpTo(segments[Number(span.dataset.index)].start);
      if (audio.paused) audio.play().catch(() => {});
    });
    // A finger scrolling the text pauses the auto-scroll for a few seconds.
    const pauseFollow = () => { userScrollUntil = Date.now() + 4000; };
    window.addEventListener('touchmove', pauseFollow, { passive: true, signal: off.signal });
    window.addEventListener('wheel', pauseFollow, { passive: true, signal: off.signal });

    // With the screen locked there are no animation frames, but timeupdate still arrives.
    audio.addEventListener('timeupdate', checkRepeat, listen);
    audio.addEventListener('play', () => {
      play.innerHTML = icon('pause');
      play.setAttribute('aria-label', '일시정지');
      if (!frame) frame = requestAnimationFrame(loop);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }, listen);
    audio.addEventListener('pause', () => {
      play.innerHTML = icon('play');
      play.setAttribute('aria-label', '재생');
      tick();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }, listen);
    audio.addEventListener('seeked', tick, listen);
    audio.addEventListener('loadedmetadata', () => {
      seek.max = audio.duration || seek.max;
      total.textContent = clock(audio.duration);
      if (options.startAt && options.startAt < audio.duration - 5) jumpTo(options.startAt);
    }, listen);
    audio.addEventListener('ended', () => {
      if (repeatMode !== 'off') {
        const segment = repeatMode === 'sentence' && segments[repeatIndex];
        audio.currentTime = segment ? segment.start : 0;
        audio.play().catch(() => {});
        return;
      }
      tick();
      if (options.onEnded) options.onEnded();
    }, listen);
    if (options.autoplay) audio.play().catch(() => {});

    // Lock screen and Control Center show the article and drive the same controls.
    if ('mediaSession' in navigator) {
      const session = navigator.mediaSession;
      const artwork = [192, 512].map((size) => ({ src: new URL(`icons/icon-${size}.png`, location.href).href, sizes: `${size}x${size}`, type: 'image/png' }));
      session.metadata = new MediaMetadata({ title: article.title || 'Listen Note', artist: article.source || '', album: 'Listen Note', artwork });
      const actions = {
        play: () => audio.play().catch(() => {}),
        pause: () => audio.pause(),
        seekbackward: () => jumpTo(audio.currentTime - 15),
        seekforward: () => jumpTo(audio.currentTime + 15),
        previoustrack: () => sentence(-1),
        nexttrack: () => sentence(1),
        seekto: (details) => jumpTo(details.seekTime),
      };
      Object.entries(actions).forEach(([name, handler]) => {
        try { session.setActionHandler(name, handler); } catch (error) { /* not supported here */ }
      });
    }

    return {
      audio,
      // keepPlaying: the next text takes over the same audio element without a pause.
      stop(keepPlaying = false) {
        off.abort();
        cancelAnimationFrame(frame);
        if (keepPlaying) return;
        audio.pause();
        if (!shared) {
          audio.removeAttribute('src');
          audio.load();
        }
      },
    };
  }

  window.ListenPlayer = { mount, clock, segmentAt };
}());
