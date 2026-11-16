// Listen Note iPhone app: unlocks the encrypted library once, then lists and plays the saved texts.
(function () {
  const app = document.getElementById('app');
  const toastBox = document.getElementById('toast');
  const PROGRESS_KEY = 'listen-note-progress';
  const FILTER_KEY = 'listen-note-filter';
  const PLAYLIST_KEY = 'listen-note-playlist';
  let key = null;
  let library = [];
  let player = null;
  let audioUrl = null;
  // One audio element for every text, so iOS keeps playing from one text to the next with the screen locked.
  const audio = new Audio();
  let queue = null;      // the playlist being played: { ids, index, loop }
  let ready = null;      // the next playlist text, already decrypted: { id, url }
  let selecting = false; // choosing texts for the playlist
  let picked = [];
  let filter = localStorage.getItem(FILTER_KEY) || 'all';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, isError = false) {
    toastBox.textContent = message;
    toastBox.classList.toggle('error', isError);
    toastBox.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastBox.classList.remove('show'), isError ? 6000 : 3000);
  }

  // ---------- Key storage (IndexedDB keeps the key itself; it cannot be read back out) ----------

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('listen-note', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('keys');
        request.result.createObjectStore('audio');  // encrypted mp3 files saved for offline listening
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function stored(name, mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction(name, mode).objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const loadSavedKey = () => stored('keys', 'readonly', (store) => store.get('main')).catch(() => null);
  const saveKey = (record) => stored('keys', 'readwrite', (store) => store.put(record, 'main'));
  const forgetKey = () => stored('keys', 'readwrite', (store) => store.delete('main'));

  function bytes(base64) {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  async function deriveKey(passphrase, info) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(info.salt), iterations: info.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  }

  function open(cryptoKey, buffer) {
    const data = new Uint8Array(buffer);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, cryptoKey, data.slice(12));
  }

  // ---------- Progress ----------

  function progressAll() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch (error) { return {}; }
  }

  function setProgress(id, values) {
    const all = progressAll();
    all[id] = { ...(all[id] || {}), ...values, at: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  }

  // ---------- Loading ----------

  async function fetchOk(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`불러오지 못했습니다 (${response.status})`);
    return response;
  }

  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    let info;
    try {
      const response = await fetch('data/key.json', { cache: 'no-cache' });
      if (response.status === 404) {
        showMessage('아직 게시된 글이 없습니다', '맥의 Listen Note에서 [Publish to Phone]을 누른 뒤 1~2분 후 다시 열어 주세요.');
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      info = await response.json();
    } catch (error) {
      showMessage('목록을 불러오지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요.');
      return;
    }
    const saved = await loadSavedKey();
    if (saved && saved.salt === info.salt) {
      key = saved.key;
      await loadLibrary();
    } else {
      showLock(info, Boolean(saved));
    }
  }

  async function loadLibrary() {
    try {
      const buffer = await (await fetchOk('data/library.bin', { cache: 'no-cache' })).arrayBuffer();
      library = JSON.parse(new TextDecoder().decode(await open(key, buffer))).articles;
    } catch (error) {
      showMessage('목록을 열지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요. 계속 안 되면 아래 [잠그기]로 비밀번호를 다시 입력하세요.', true);
      return;
    }
    cleanSavedAudio();
    route();
  }

  function showMessage(title, text, withLock = false) {
    const box = el('section', 'phone-message');
    box.append(el('h1', '', title), el('p', 'muted', text));
    if (withLock) box.append(lockButton());
    app.replaceChildren(box);
  }

  function showLock(info, changed) {
    const box = el('form', 'phone-lock');
    box.append(el('div', 'lock-icon'), el('h1', '', 'Listen Note'));
    box.append(el('p', 'muted', changed
      ? '맥에서 게시 비밀번호를 새로 정했습니다. 새 비밀번호를 입력하세요.'
      : '맥에서 게시할 때 정한 비밀번호를 한 번 입력하세요. 이 아이폰에서는 다시 묻지 않습니다.'));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = '게시 비밀번호';
    const error = el('p', 'notice');
    error.hidden = true;
    const go = el('button', 'button primary wide', '열기');
    go.type = 'submit';
    box.append(input, error, go);
    box.addEventListener('submit', async (event) => {
      event.preventDefault();
      go.disabled = true;
      go.textContent = '확인 중…';
      error.hidden = true;
      try {
        const candidate = await deriveKey(input.value, info);
        await open(candidate, bytes(info.check));
        key = candidate;
        input.value = '';
        await saveKey({ key: candidate, salt: info.salt });
        await loadLibrary();
      } catch (problem) {
        error.textContent = '비밀번호가 맞지 않습니다.';
        error.hidden = false;
        go.disabled = false;
        go.textContent = '열기';
      }
    });
    app.replaceChildren(box);
    input.focus();
  }

  function lockButton() {
    const lock = el('button', 'link', '잠그기');
    lock.type = 'button';
    lock.addEventListener('click', async () => {
      if (!confirm('이 아이폰에서 비밀번호를 지우고 잠글까요? 다음에 열 때 다시 입력합니다.')) return;
      await forgetKey();
      location.reload();
    });
    return lock;
  }

  // ---------- Offline audio ----------
  // Kept in IndexedDB, not Cache Storage: other apps on this address clear each other's caches.

  const audioName = (article) => article.audio.split('/').pop();

  async function savedNames() {
    try {
      return new Set(await stored('audio', 'readonly', (store) => store.getAllKeys()));
    } catch (error) {
      return new Set();
    }
  }

  async function cleanSavedAudio() {
    const wanted = new Set(library.map(audioName));
    for (const name of await savedNames()) {
      if (!wanted.has(name)) await stored('audio', 'readwrite', (store) => store.delete(name)).catch(() => {});
    }
  }

  // The encrypted file, from this iPhone when saved, otherwise downloaded and saved for next time.
  async function encryptedAudio(article) {
    const name = audioName(article);
    const saved = await stored('audio', 'readonly', (store) => store.get(name)).catch(() => null);
    if (saved) return saved;
    const buffer = await (await fetchOk(article.audio)).arrayBuffer();
    await stored('audio', 'readwrite', (store) => store.put(buffer, name)).catch(() => {});
    return buffer;
  }

  async function saveAll(button) {
    const have = await savedNames();
    const missing = library.filter((article) => !have.has(audioName(article)));
    if (!missing.length) {
      toast('모든 글이 이미 저장되어 있습니다');
      return;
    }
    button.disabled = true;
    let done = 0;
    for (const article of missing) {
      button.textContent = `저장 중 ${done + 1}/${missing.length}`;
      try {
        await encryptedAudio(article);
        done += 1;
      } catch (error) {
        toast('일부 글을 저장하지 못했습니다. Wi-Fi에서 다시 눌러 주세요.', true);
        break;
      }
    }
    button.disabled = false;
    if (done === missing.length) toast(`글 ${done}개를 이 아이폰에 저장했습니다`);
    showList();
  }

  // ---------- Views ----------

  function day(value) {
    return value ? value.slice(0, 10) : '';
  }

  function stopPlayer() {
    if (player) player.stop();
    player = null;
    audio.removeAttribute('src');
    audio.load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    dropReady();
  }

  function dropReady() {
    if (ready) URL.revokeObjectURL(ready.url);
    ready = null;
  }

  // iOS lets a page start sound only from a tap. Playing a moment of silence during the tap
  // unlocks the element, so the text can start once it has been decrypted.
  function unlockAudio() {
    const wav = new Uint8Array(46);
    const view = new DataView(wav.buffer);
    [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']].forEach(([at, text]) => [...text].forEach((c, i) => { wav[at + i] = c.charCodeAt(0); }));
    view.setUint32(4, 38, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, 2, true);
    audio.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    audio.play().catch(() => {});
  }

  async function mp3Url(article) {
    const mp3 = await open(key, await encryptedAudio(article));
    return URL.createObjectURL(new Blob([mp3], { type: 'audio/mpeg' }));
  }

  // ---------- Playlist ----------

  function savedPlaylist() {
    try {
      const saved = JSON.parse(localStorage.getItem(PLAYLIST_KEY)) || {};
      const known = new Set(library.map((article) => article.id));
      return { ids: (saved.ids || []).filter((id) => known.has(id)), loop: Boolean(saved.loop) };
    } catch (error) {
      return { ids: [], loop: false };
    }
  }

  function savePlaylist(values) {
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify({ ...savedPlaylist(), ...values }));
  }

  function nextIndex(step) {
    const target = queue.index + step;
    if (target >= 0 && target < queue.ids.length) return target;
    if (queue.loop) return (target + queue.ids.length) % queue.ids.length;
    return -1;
  }

  async function prepareNext() {
    if (!queue) return;
    const index = nextIndex(1);
    const id = index >= 0 ? queue.ids[index] : null;
    if (!id || (ready && ready.id === id)) return;
    const article = library.find((item) => item.id === id);
    try {
      const url = await mp3Url(article);
      if (queue && queue.ids[nextIndex(1)] === id) {
        dropReady();
        ready = { id, url };
      } else {
        URL.revokeObjectURL(url);
      }
    } catch (error) { /* it is fetched again when its turn comes */ }
  }

  function advance(step, playing) {
    const index = nextIndex(step);
    if (index < 0) {
      if (step > 0) toast('재생목록을 끝까지 들었습니다');
      return;
    }
    queue.index = index;
    history.replaceState({ fromList: true }, '', `#a=${queue.ids[index]}`);
    showArticle(queue.ids[index], { autoplay: playing });
  }

  function playPlaylist(ids, loop) {
    unlockAudio();
    queue = { ids, index: 0, loop };
    dropReady();
    history.pushState({ fromList: true }, '', `#a=${ids[0]}`);
    showArticle(ids[0], { autoplay: true });
  }

  // ---------- List ----------

  function button(label, className, action) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function totalTime(ids) {
    return ListenPlayer.clock(ids.reduce((sum, id) => sum + ((library.find((a) => a.id === id) || {}).duration || 0), 0));
  }

  function playlistPanel() {
    const playlist = savedPlaylist();
    const panel = el('section', 'playlist-panel');
    const text = el('div', 'playlist-text');
    text.append(el('strong', '', '재생목록'));
    text.append(el('span', 'muted', playlist.ids.length
      ? ` · ${playlist.ids.length}개 · ${totalTime(playlist.ids)}`
      : ' · 글을 골라 이어서 들어요'));
    const titles = playlist.ids.map((id) => library.find((a) => a.id === id)).filter(Boolean);
    if (titles.length) {
      const names = el('ol', 'playlist-titles');
      titles.slice(0, 3).forEach((article, i) => names.append(el('li', '', `${i + 1}. ${article.title || '제목 없음'}`)));
      text.append(names);
      if (titles.length > 3) text.append(el('p', 'muted playlist-more', `외 ${titles.length - 3}개`));
    }
    panel.append(text);
    const actions = el('div', 'playlist-actions');
    actions.append(button(playlist.ids.length ? '선택' : '글 선택', 'button small', () => {
      selecting = true;
      picked = [...playlist.ids];
      showList();
    }));
    if (playlist.ids.length) {
      actions.append(button('▶ 재생', 'button small primary', () => playPlaylist(playlist.ids, playlist.loop)));
    }
    panel.append(actions);
    return panel;
  }

  function selectBar() {
    const bar = el('div', 'select-bar');
    bar.append(el('span', 'select-count', picked.length ? `${picked.length}개 · ${totalTime(picked)}` : '들을 순서대로 누르세요'));
    bar.append(button('비우기', 'button small', () => { picked = []; showList(); }));
    bar.append(button('취소', 'button small', () => { selecting = false; showList(); }));
    const done = button('저장', 'button small primary', () => {
      savePlaylist({ ids: picked });
      selecting = false;
      showList();
    });
    bar.append(done);
    return bar;
  }

  async function showList() {
    stopPlayer();
    queue = null;
    const progress = progressAll();
    const have = await savedNames();
    const page = el('section', selecting ? 'phone-list selecting' : 'phone-list');
    const head = el('header', 'phone-head');
    head.append(el('h1', '', 'Listen Note'));
    const save = el('button', 'button small', '모두 저장');
    save.type = 'button';
    save.title = '지하철처럼 인터넷이 없는 곳에서도 듣도록 이 아이폰에 저장';
    save.addEventListener('click', () => saveAll(save));
    head.append(save);
    page.append(head);
    if (!selecting && library.length) page.append(playlistPanel());

    const tabs = el('div', 'tabs');
    [['all', '전체'], ['new', '안 들은 글'], ['done', '다 들은 글']].forEach(([value, label]) => {
      const tab = el('button', value === filter ? 'tab active' : 'tab', label);
      tab.type = 'button';
      tab.addEventListener('click', () => {
        filter = value;
        localStorage.setItem(FILTER_KEY, value);
        showList();
      });
      tabs.append(tab);
    });
    page.append(tabs);

    const shown = library.filter((article) => {
      const done = Boolean(progress[article.id] && progress[article.id].done);
      return filter === 'all' || (filter === 'done' ? done : !done);
    });
    const list = el('div', 'phone-cards');
    if (!shown.length) list.append(el('p', 'muted empty-note', library.length ? '이 목록에 글이 없습니다.' : '아직 게시된 글이 없습니다. 맥에서 [Publish to Phone]을 누르세요.'));
    shown.forEach((article) => {
      const state = progress[article.id] || {};
      const card = el('a', 'phone-card');
      card.href = `#a=${article.id}`;
      card.dataset.id = article.id;
      const order = picked.indexOf(article.id);
      if (selecting) {
        card.classList.toggle('picked', order >= 0);
        card.append(el('span', 'pick-mark', order >= 0 ? String(order + 1) : ''));
      }
      card.append(el('h2', '', article.title || '제목 없음'));
      const details = [article.source, day(article.published) || day(article.created_at), ListenPlayer.clock(article.duration)].filter(Boolean);
      card.append(el('p', 'muted', details.join(' · ')));
      const foot = el('div', 'card-foot');
      if (state.done) foot.append(el('span', 'chip done', '다 들음'));
      else if (state.pos > 5) foot.append(el('span', 'chip', `${ListenPlayer.clock(state.pos)}부터 이어 듣기`));
      if (have.has(audioName(article))) foot.append(el('span', 'chip saved', '저장됨'));
      if (foot.childNodes.length) card.append(foot);
      if (state.pos && !state.done && article.duration) {
        const bar = el('div', 'card-progress');
        const fill = el('span');
        fill.style.width = `${Math.min(100, (state.pos / article.duration) * 100)}%`;
        bar.append(fill);
        card.append(bar);
      }
      list.append(card);
    });
    page.append(list);
    if (selecting) {
      page.append(selectBar());
    } else {
      const foot = el('footer', 'phone-foot');
      foot.append(lockButton());
      page.append(foot);
    }
    app.replaceChildren(page);
  }

  // ---------- One text ----------

  function queueStrip() {
    const strip = el('div', 'queue-strip');
    strip.append(el('span', 'queue-place', `재생목록 ${queue.index + 1} / ${queue.ids.length}`));
    const controls = el('div', 'queue-controls');
    const prev = button('‹ 이전 글', 'button small', () => advance(-1, !audio.paused));
    prev.disabled = nextIndex(-1) < 0;
    const next = button('다음 글 ›', 'button small', () => advance(1, !audio.paused));
    next.disabled = nextIndex(1) < 0;
    const loop = button('목록 반복', 'button small queue-loop', () => {
      queue.loop = !queue.loop;
      savePlaylist({ loop: queue.loop });
      loop.setAttribute('aria-pressed', String(queue.loop));
      prev.disabled = nextIndex(-1) < 0;
      next.disabled = nextIndex(1) < 0;
      prepareNext();
    });
    loop.setAttribute('aria-pressed', String(queue.loop));
    controls.append(prev, next, loop);
    strip.append(controls);
    return strip;
  }

  async function showArticle(id, { autoplay = false } = {}) {
    const article = library.find((item) => item.id === id);
    if (queue && queue.ids[queue.index] !== id) {
      const index = queue.ids.indexOf(id);
      if (index >= 0) queue.index = index;
      else queue = null;  // opened on its own, not from the playlist
    }
    if (player) player.stop(autoplay);  // the same audio element carries on into the next text
    player = null;
    if (!article) {
      stopPlayer();
      history.replaceState(null, '', location.pathname);
      showList();
      return;
    }
    const page = el('section', 'phone-article');
    const top = el('div', 'phone-top');
    const back = el('a', 'back-link', '‹ 목록');
    back.href = '#';
    back.addEventListener('click', (event) => {
      event.preventDefault();
      if (history.state && history.state.fromList) history.back();
      else {
        history.replaceState(null, '', location.pathname);
        showList();
      }
    });
    top.append(back);
    page.append(top);
    if (queue) page.append(queueStrip());
    const holder = el('div');
    holder.append(el('p', 'muted loading', '음성을 여는 중…'));
    page.append(holder);
    app.replaceChildren(page);
    window.scrollTo(0, 0);

    let url;
    if (ready && ready.id === id) {
      url = ready.url;
      ready = null;
    } else {
      try {
        url = await mp3Url(article);
      } catch (error) {
        holder.replaceChildren(el('p', 'notice', '음성을 열지 못했습니다. 인터넷에 연결했는지 확인해 주세요.'));
        return;
      }
    }
    if (!document.body.contains(holder)) {  // the user already moved on
      URL.revokeObjectURL(url);
      return;
    }
    const previousUrl = audioUrl;
    audioUrl = url;
    const state = progressAll()[article.id] || {};
    let lastSaved = 0;
    player = ListenPlayer.mount(holder, {
      article,
      audio,
      src: url,
      autoplay,
      startAt: state.done ? 0 : state.pos,
      onPosition(position, duration) {
        if (Math.abs(position - lastSaved) < 2) return;
        lastSaved = position;
        const values = { pos: position };
        if (duration && position / duration > 0.97) values.done = true;
        setProgress(article.id, values);
      },
      onEnded() {
        setProgress(article.id, { pos: 0, done: true });
        if (queue) advance(1, true);
      },
    });
    if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
    if (queue && 'mediaSession' in navigator) {
      // On the lock screen the track buttons move through the playlist.
      try {
        navigator.mediaSession.setActionHandler('nexttrack', nextIndex(1) >= 0 ? () => advance(1, !audio.paused) : null);
        navigator.mediaSession.setActionHandler('previoustrack', nextIndex(-1) >= 0 ? () => advance(-1, !audio.paused) : null);
      } catch (error) { /* not supported here */ }
    }
    prepareNext();
  }

  function route() {
    const match = location.hash.match(/^#a=([0-9a-f]+)$/);
    if (match) showArticle(match[1]);
    else showList();
  }

  app.addEventListener('click', (event) => {
    const card = event.target.closest('.phone-card');
    if (!card) return;
    event.preventDefault();
    if (selecting) {
      const id = card.dataset.id;
      picked = picked.includes(id) ? picked.filter((item) => item !== id) : [...picked, id];
      showList();
      return;
    }
    // Opening a card adds a history entry, so the back swipe returns to the list.
    queue = null;
    history.pushState({ fromList: true }, '', card.getAttribute('href'));
    route();
  });
  window.addEventListener('popstate', () => { if (key) route(); });

  start();
}());
