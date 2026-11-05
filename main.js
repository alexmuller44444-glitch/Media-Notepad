/* Media Notepad — frontend (vanilla JS, no bundler) */
(() => {
  "use strict";

  const tauri = window.__TAURI__;
  if (!tauri) {
    document.body.innerHTML =
      '<pre style="padding:24px;color:#f66;font-family:Consolas">Tauri API unavailable.</pre>';
    return;
  }

  const { invoke, convertFileSrc } = tauri.core;
  const appWindow = tauri.window.getCurrentWindow();

  const SAVE_DELAY = 350;
  const LAST_NOTE_KEY = "mn-last-note";
  const THEME_KEY = "mn-theme";
  const WRAP_KEY = "mn-wrap";
  const ZOOM_KEY = "mn-zoom";

  const $ = (id) => document.getElementById(id);

  const els = {
    app: $("app"),
    tabs: $("tabs"),
    menubar: $("menubar"),
    editor: $("editor"),
    statusLn: $("statusLn"),
    statusChars: $("statusChars"),
    statusSave: $("statusSave"),
    newTabBtn: $("newTabBtn"),
    filePicker: $("filePicker"),
    toast: $("toast"),
    modal: $("modal"),
    modalTitle: $("modalTitle"),
    modalText: $("modalText"),
    modalOk: $("modalOk"),
    modalCancel: $("modalCancel"),
  };

  const state = {
    info: null,
    notes: [],
    current: null,
    dirty: false,
    queued: false,
    timer: null,
    rev: 0,
    caret: null,
    theme: localStorage.getItem(THEME_KEY) || "dark",
    wrap: localStorage.getItem(WRAP_KEY) !== "off",
    zoom: Number(localStorage.getItem(ZOOM_KEY)) || 15,
    openMenu: null,
    order: [],
    dragId: null,
  };

  let inflight = null;
  let toastTimer = null;
  let lastDocTitle = "";

  const ICON_X =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  const makeId = () =>
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const joinPath = (dir, name) =>
    String(dir).replace(/[\\/]+$/, "") + "/" + name;

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }

  function setSaveState(text, tone) {
    els.statusSave.textContent = text;
    els.statusSave.className = "status-item save-state" + (tone ? " " + tone : "");
  }

  function setDocTitle(title) {
    const clean = title && title !== "Untitled" ? title : "Untitled";
    if (clean === lastDocTitle) return;
    lastDocTitle = clean;
    document.title = clean + " - Media Notepad";
    appWindow.setTitle(clean + " - Media Notepad").catch(() => {});
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    appWindow.setTheme(theme).catch(() => {});
  }

  function applyWrap() {
    els.editor.classList.toggle("no-wrap", !state.wrap);
    localStorage.setItem(WRAP_KEY, state.wrap ? "on" : "off");
  }

  function applyZoom() {
    const size = Math.min(28, Math.max(11, state.zoom));
    state.zoom = size;
    document.documentElement.style.setProperty("--editor-size", size + "px");
    localStorage.setItem(ZOOM_KEY, String(size));
  }

  function editorIsEmpty() {
    const text = els.editor.textContent.replace(/\u00a0/g, " ").trim();
    return text.length === 0 && !els.editor.querySelector("img, video, audio");
  }

  function updateEmptyClass() {
    els.editor.classList.toggle("is-empty", editorIsEmpty());
  }

  function deriveTitle() {
    const text = els.editor.innerText.replace(/\u00a0/g, " ");
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) {
      return els.editor.querySelector("img, video, audio") ? "Media note" : "Untitled";
    }
    return line.length > 60 ? line.slice(0, 60) + "…" : line;
  }

  /* ------------------------------------------------------------------ */
  /* Status bar                                                          */
  /* ------------------------------------------------------------------ */

  function blockText(node) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      const name = n.nodeName;
      if (name === "BR") {
        out += "\n";
        return;
      }
      const isBlock = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/.test(name);
      if (isBlock && out && !out.endsWith("\n")) out += "\n";
      for (const child of n.childNodes) walk(child);
      if (isBlock && !out.endsWith("\n")) out += "\n";
    };
    for (const child of node.childNodes) walk(child);
    return out;
  }

  function textBeforeCaret() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return "";
    const range = sel.getRangeAt(0);
    if (!els.editor.contains(range.endContainer)) return "";
    const pre = document.createRange();
    pre.selectNodeContents(els.editor);
    try {
      pre.setEnd(range.endContainer, range.endOffset);
    } catch {
      return "";
    }
    return blockText(pre.cloneContents());
  }

  function updateStatus() {
    const text = els.editor.innerText.replace(/\u00a0/g, " ");
    const chars = text.length;
    els.statusChars.textContent = `${chars} ${chars === 1 ? "character" : "characters"}`;

    const before = textBeforeCaret();
    const lines = before.split("\n");
    els.statusLn.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  }

  let statusFrame = 0;
  function queueStatus() {
    if (statusFrame) return;
    statusFrame = requestAnimationFrame(() => {
      statusFrame = 0;
      updateStatus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */

  async function refreshNotes() {
    const [notes, order] = await Promise.all([
      invoke("list_notes"),
      invoke("load_order").catch(() => []),
    ]);
    state.order = Array.isArray(order) ? order : [];
    state.notes = sortNotes(notes);
    renderTabs();
  }

  function sortNotes(notes) {
    const index = new Map();
    state.order.forEach((id, i) => index.set(id, i));
    return notes.slice().sort((a, b) => {
      const ai = index.has(a.id) ? index.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = index.has(b.id) ? index.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.created - b.created || a.id.localeCompare(b.id);
    });
  }

  function persistOrder() {
    const ids = state.notes.map((note) => note.id);
    state.order = ids;
    invoke("save_order", { ids }).catch((err) => {
      showToast("Could not save tab order: " + err);
    });
  }

  function clearDropMarkers() {
    for (const el of els.tabs.querySelectorAll(".drop-before, .drop-after")) {
      el.classList.remove("drop-before", "drop-after");
    }
  }

  function moveNote(sourceId, targetId, before) {
    if (!sourceId || sourceId === targetId) return;
    const from = state.notes.findIndex((note) => note.id === sourceId);
    if (from < 0) return;
    const [moved] = state.notes.splice(from, 1);
    let to = state.notes.findIndex((note) => note.id === targetId);
    if (to < 0) {
      state.notes.splice(from, 0, moved);
      return;
    }
    if (!before) to += 1;
    state.notes.splice(to, 0, moved);
    renderTabs();
    persistOrder();
  }

  function renderTabs() {
    const frag = document.createDocumentFragment();
    for (const note of state.notes) {
      const tab = document.createElement("div");
      tab.className =
        "tab" + (state.current && state.current.id === note.id ? " active" : "");
      tab.dataset.id = note.id;
      tab.setAttribute("role", "tab");
      tab.title = note.title || "Untitled";
      tab.draggable = true;

      tab.addEventListener("dragstart", (event) => {
        state.dragId = note.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", note.id);
        tab.classList.add("dragging");
      });

      tab.addEventListener("dragend", () => {
        state.dragId = null;
        tab.classList.remove("dragging");
        clearDropMarkers();
      });

      tab.addEventListener("dragover", (event) => {
        if (!state.dragId || state.dragId === note.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = tab.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        clearDropMarkers();
        tab.classList.add(before ? "drop-before" : "drop-after");
      });

      tab.addEventListener("dragleave", () => {
        tab.classList.remove("drop-before", "drop-after");
      });

      tab.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetId = note.id;
        const rect = tab.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const sourceId = state.dragId || event.dataTransfer.getData("text/plain");
        clearDropMarkers();
        state.dragId = null;
        moveNote(sourceId, targetId, before);
      });

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = note.title || "Untitled";

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.title = "Delete note";
      close.draggable = false;
      close.innerHTML = ICON_X;
      close.addEventListener("dragstart", (event) => event.preventDefault());
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeNote(note.id);
      });

      tab.append(label, close);
      tab.addEventListener("click", () => openNote(note.id));
      tab.addEventListener("auxclick", (event) => {
        if (event.button === 1) closeNote(note.id);
      });
      frag.append(tab);
    }
    els.tabs.replaceChildren(frag);

    const active = els.tabs.querySelector(".tab.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function updateActiveTabTitle(title) {
    const label = els.tabs.querySelector(".tab.active .tab-label");
    if (label) label.textContent = title || "Untitled";
    const tab = els.tabs.querySelector(".tab.active");
    if (tab) tab.title = title || "Untitled";
  }

  /* ------------------------------------------------------------------ */
  /* Notes                                                               */
  /* ------------------------------------------------------------------ */

  function hydrateMedia() {
    if (!state.info) return;
    for (const el of els.editor.querySelectorAll("[data-media]")) {
      const name = el.getAttribute("data-media");
      if (!name) continue;
      el.setAttribute("src", convertFileSrc(joinPath(state.info.mediaDir, name)));
      if (el.tagName === "IMG") el.setAttribute("draggable", "false");
    }
  }

  function loadIntoEditor(html) {
    els.editor.innerHTML = html || "";
    hydrateMedia();
    updateEmptyClass();
    updateStatus();
    state.rev++;
    state.dirty = false;
    els.editor.scrollTop = 0;
  }

  async function openNote(id) {
    if (state.current && state.current.id === id) {
      els.editor.focus();
      return;
    }
    await flush();

    try {
      const note = await invoke("load_note", { id });
      state.current = note;
      loadIntoEditor(note.html);
      setDocTitle(note.title);
      setSaveState("Saved", "ok");
      localStorage.setItem(LAST_NOTE_KEY, note.id);
      renderTabs();
      els.editor.focus();
    } catch (err) {
      showToast("Could not open note: " + err);
    }
  }

  async function createNote() {
    await flush();

    if (state.current && editorIsEmpty()) {
      els.editor.focus();
      return;
    }

    const note = {
      id: makeId(),
      title: "Untitled",
      html: "",
      created: Date.now(),
      updated: Date.now(),
    };
    state.current = note;
    loadIntoEditor("");
    setDocTitle("Untitled");
    await saveNow();
    await refreshNotes();
    localStorage.setItem(LAST_NOTE_KEY, note.id);
    els.editor.focus();
  }

  async function closeNote(id) {
    const meta = state.notes.find((n) => n.id === id);
    if (!meta) return;

    const isCurrent = state.current && state.current.id === id;
    if (isCurrent) await flush();

    const ok = await confirmDialog(
      "Delete note?",
      `“${meta.title || "Untitled"}” and the media inside it will be permanently deleted.`,
      "Delete"
    );
    if (!ok) return;

    try {
      await invoke("delete_note", { id });
    } catch (err) {
      showToast("Could not delete note: " + err);
      return;
    }

    if (isCurrent) {
      state.current = null;
      clearTimeout(state.timer);
      state.timer = null;
      state.dirty = false;
    }

    await refreshNotes();

    if (isCurrent) {
      if (state.notes.length > 0) await openNote(state.notes[0].id);
      else await createNote();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Saving                                                              */
  /* ------------------------------------------------------------------ */

  function scheduleSave() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      saveNow();
    }, SAVE_DELAY);
  }

  function saveNow() {
    if (!state.current) return Promise.resolve();
    if (inflight) {
      state.queued = true;
      return inflight;
    }

    const note = state.current;
    const rev = state.rev;
    const html = els.editor.innerHTML;
    const title = deriveTitle();
    note.html = html;
    note.title = title;

    setSaveState("Saving…", "busy");

    const run = (async () => {
      try {
        const meta = await invoke("save_note", {
          id: note.id,
          title,
          html,
          created: note.created,
        });
        note.updated = meta.updated;

        if (state.rev === rev) {
          state.dirty = false;
          setSaveState("Saved", "ok");
        }
        localStorage.setItem(LAST_NOTE_KEY, note.id);
        setDocTitle(title);
        updateActiveTabTitle(title);
        updateNoteMeta(note);
      } catch (err) {
        setSaveState("Save failed", "error");
        showToast("Could not save note: " + err);
      }
    })();

    // `finish` also covers the queued follow-up save, so callers (flush,
    // tab switches, window close) wait until everything is on disk.
    const finish = (async () => {
      try {
        await run;
      } finally {
        inflight = null;
      }
      if (state.queued) {
        state.queued = false;
        if (state.dirty) await saveNow();
      }
    })();

    inflight = finish;
    return finish;
  }

  async function flush() {
    clearTimeout(state.timer);
    state.timer = null;
    if (state.dirty) await saveNow();
    if (inflight) await inflight;
  }

  function updateNoteMeta(note) {
    const entry = state.notes.find((n) => n.id === note.id);
    if (!entry) return;
    entry.title = note.title;
    entry.updated = note.updated || Date.now();
    // Keep the tab order stable while typing; ordering is refreshed when notes
    // are created or deleted.
  }

  /* ------------------------------------------------------------------ */
  /* Editing                                                             */
  /* ------------------------------------------------------------------ */

  function onInput() {
    state.rev++;
    state.dirty = true;
    updateEmptyClass();
    queueStatus();
    const title = deriveTitle();
    setDocTitle(title);
    updateActiveTabTitle(title);
    scheduleSave();
  }

  function syncCaret() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (els.editor.contains(range.commonAncestorContainer)) {
        state.caret = range.cloneRange();
      }
    }
  }

  function restoreCaret() {
    els.editor.focus();
    if (!state.caret) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(state.caret);
  }

  function insertHtmlAtCaret(html) {
    restoreCaret();
    const marker = "mn-caret-marker";
    document.execCommand(
      "insertHTML",
      false,
      html + `<span id="${marker}"></span>`
    );
    const node = els.editor.querySelector("#" + marker);
    if (node) {
      const range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      node.remove();
    }
    syncCaret();
    onInput();
  }

  function insertTextAtCaret(text) {
    restoreCaret();
    document.execCommand("insertText", false, text);
    syncCaret();
    onInput();
  }

  function exec(command) {
    els.editor.focus();
    document.execCommand(command, false);
    syncCaret();
    queueStatus();
  }

  async function pasteFromClipboard() {
    // Images are read in Rust so no WebView clipboard permission prompt appears.
    try {
      const name = await invoke("paste_clipboard_image");
      if (name) {
        insertHtmlAtCaret(mediaHtml(name, "image"));
        return;
      }
    } catch (err) {
      console.error(err);
    }

    try {
      const text = await invoke("read_clipboard_text");
      if (text) insertTextAtCaret(text);
      else showToast("Clipboard is empty");
    } catch {
      showToast("Press Ctrl+V to paste");
    }
  }

  function mediaHtml(name, kind) {
    const src = convertFileSrc(joinPath(state.info.mediaDir, name));
    const common = `class="media ${kind}" data-media="${name}" src="${src}"`;
    if (kind === "image") {
      return `<img ${common} alt="" draggable="false"><br>`;
    }
    return `<${kind} ${common} controls preload="metadata"></${kind}><br>`;
  }

  function kindOf(file) {
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";

    const ext = (file.name || "").split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext))
      return "image";
    if (["mp4", "webm", "mov", "m4v", "mkv", "ogv", "avi"].includes(ext)) return "video";
    if (["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"].includes(ext)) return "audio";
    return "other";
  }

  function extensionFor(file) {
    const fromName = (file.name || "").includes(".")
      ? file.name.split(".").pop()
      : "";
    if (fromName && fromName.length <= 12) {
      return fromName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
    }
    const map = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
      "image/svg+xml": "svg",
      "image/avif": "avif",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
    };
    return map[(file.type || "").toLowerCase()] || "bin";
  }

  async function insertFile(file) {
    const kind = kindOf(file);
    if (kind === "other") {
      insertTextAtCaret(`[${file.name}]`);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const ext = extensionFor(file);
      const fullPath = await invoke("save_media", bytes, {
        headers: { "x-ext": ext },
      });

      const name = String(fullPath).split(/[\\/]/).pop();
      insertHtmlAtCaret(mediaHtml(name, kind));
    } catch (err) {
      console.error(err);
      showToast("Could not insert “" + (file.name || "file") + "”: " + err);
    }
  }

  async function insertFiles(files) {
    for (const file of files) {
      if (!file || !file.size) continue;
      await insertFile(file);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Menus                                                               */
  /* ------------------------------------------------------------------ */

  const MENUS = [
    {
      label: "File",
      items: () => [
        { label: "New note", shortcut: "Ctrl+N", action: () => createNote() },
        { label: "Save now", shortcut: "Ctrl+S", action: () => flush() },
        { sep: true },
        {
          label: "Insert image, video or audio…",
          shortcut: "Ctrl+Shift+I",
          action: () => pickMedia(),
        },
        { label: "Open data folder", action: () => openDataFolder() },
        { sep: true },
        { label: "Exit", action: () => appWindow.close() },
      ],
    },
    {
      label: "Edit",
      items: () => [
        { label: "Undo", shortcut: "Ctrl+Z", action: () => exec("undo") },
        { label: "Redo", shortcut: "Ctrl+Y", action: () => exec("redo") },
        { sep: true },
        { label: "Cut", shortcut: "Ctrl+X", action: () => exec("cut") },
        { label: "Copy", shortcut: "Ctrl+C", action: () => exec("copy") },
        { label: "Paste", shortcut: "Ctrl+V", action: () => pasteFromClipboard() },
        {
          label: "Select all",
          shortcut: "Ctrl+A",
          action: () => {
            els.editor.focus();
            document.execCommand("selectAll");
            syncCaret();
            queueStatus();
          },
        },
        { sep: true },
        { label: "Insert media…", action: () => pickMedia() },
      ],
    },
    {
      label: "View",
      items: () => [
        {
          label: "Word wrap",
          check: state.wrap,
          action: () => {
            state.wrap = !state.wrap;
            applyWrap();
          },
        },
        {
          label: "Dark mode",
          check: state.theme === "dark",
          action: () => applyTheme(state.theme === "dark" ? "light" : "dark"),
        },
        { sep: true },
        { label: "Zoom in", shortcut: "Ctrl++", action: () => zoomBy(1) },
        { label: "Zoom out", shortcut: "Ctrl+-", action: () => zoomBy(-1) },
        { label: "Reset zoom", shortcut: "Ctrl+0", action: () => zoomBy(0) },
      ],
    },
  ];

  function buildMenus() {
    const frag = document.createDocumentFragment();
    for (const menu of MENUS) {
      const wrap = document.createElement("div");
      wrap.className = "menu";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-btn";
      btn.textContent = menu.label;

      const panel = document.createElement("div");
      panel.className = "menu-panel";
      panel.hidden = true;

      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!panel.hidden) {
          closeMenus();
        } else {
          openMenu({ btn, panel, menu });
        }
      });

      // Hover switches menus while one is open (classic menu bar behaviour).
      btn.addEventListener("mouseenter", () => {
        if (state.openMenu && state.openMenu.panel !== panel) {
          openMenu({ btn, panel, menu });
        }
      });

      wrap.append(btn, panel);
      frag.append(wrap);
    }
    els.menubar.replaceChildren(frag);
  }

  function openMenu(entry) {
    closeMenus();
    entry.panel.replaceChildren(...buildMenuItems(entry.menu.items()));
    entry.panel.hidden = false;
    entry.btn.classList.add("open");
    state.openMenu = entry;
  }

  function closeMenus() {
    if (!state.openMenu) return;
    state.openMenu.panel.hidden = true;
    state.openMenu.btn.classList.remove("open");
    state.openMenu = null;
  }

  function buildMenuItems(items) {
    const nodes = [];
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        nodes.push(sep);
        continue;
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item";

      const check = document.createElement("span");
      check.className = "check";
      check.textContent = item.check ? "✓" : "";

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;

      const shortcut = document.createElement("span");
      shortcut.className = "shortcut";
      shortcut.textContent = item.shortcut || "";

      btn.append(check, label, shortcut);
      btn.addEventListener("click", () => {
        closeMenus();
        item.action();
      });
      nodes.push(btn);
    }
    return nodes;
  }

  function zoomBy(delta) {
    if (delta === 0) state.zoom = 15;
    else state.zoom += delta;
    applyZoom();
  }

  async function openDataFolder() {
    try {
      await invoke("open_data_folder");
    } catch (err) {
      showToast("Could not open folder: " + err);
    }
  }

  function pickMedia() {
    syncCaret();
    els.filePicker.click();
  }

  /* ------------------------------------------------------------------ */
  /* Modal                                                               */
  /* ------------------------------------------------------------------ */

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalText.textContent = text;
      els.modalOk.textContent = okLabel || "OK";
      els.modal.hidden = false;
      els.modalOk.focus();

      const done = (value) => {
        els.modal.hidden = true;
        els.modalOk.removeEventListener("click", onOk);
        els.modalCancel.removeEventListener("click", onCancel);
        els.modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          done(false);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          done(true);
        }
      };

      els.modalOk.addEventListener("click", onOk);
      els.modalCancel.addEventListener("click", onCancel);
      els.modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey, true);

      function onBackdrop(event) {
        if (event.target === els.modal) done(false);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    els.editor.addEventListener("input", onInput);

    document.addEventListener("selectionchange", () => {
      syncCaret();
      queueStatus();
    });

    els.editor.addEventListener("paste", async (event) => {
      const data = event.clipboardData;
      if (!data) return;

      const files = Array.from(data.files || []).filter((f) => f.size > 0);
      if (files.length > 0) {
        event.preventDefault();
        syncCaret();
        await insertFiles(files);
        return;
      }

      // Plain text only, like Notepad.
      const text = data.getData("text/plain");
      if (text) {
        event.preventDefault();
        document.execCommand("insertText", false, text);
        syncCaret();
      }
    });

    els.editor.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    els.editor.addEventListener("drop", async (event) => {
      event.preventDefault();
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
      if (files.length === 0) return;

      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        state.caret = range ? range.cloneRange() : null;
      }
      await insertFiles(files);
    });

    els.editor.addEventListener("blur", () => {
      if (state.dirty) saveNow();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && state.dirty) saveNow();
    });

    window.addEventListener("beforeunload", () => {
      if (state.dirty) saveNow();
    });

    if (typeof appWindow.onCloseRequested === "function") {
      appWindow
        .onCloseRequested(async (event) => {
          if (event && typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          try {
            await flush();
          } catch (err) {
            console.error(err);
          } finally {
            await appWindow.destroy().catch(() => {});
          }
        })
        .catch(() => {});
    }

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenus();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        flush();
      } else if (key === "n") {
        event.preventDefault();
        createNote();
      } else if (key === "i" && event.shiftKey) {
        event.preventDefault();
        pickMedia();
      } else if (key === "=" || key === "+") {
        event.preventDefault();
        zoomBy(1);
      } else if (key === "-") {
        event.preventDefault();
        zoomBy(-1);
      } else if (key === "0") {
        event.preventDefault();
        zoomBy(0);
      }
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu")) closeMenus();
    });

    window.addEventListener("blur", () => closeMenus());

    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());

    els.newTabBtn.addEventListener("click", () => createNote());

    els.filePicker.addEventListener("change", async () => {
      const files = Array.from(els.filePicker.files || []);
      els.filePicker.value = "";
      if (files.length > 0) await insertFiles(files);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    applyTheme(state.theme);
    applyWrap();
    applyZoom();
    buildMenus();
    bindEvents();

    try {
      state.info = await invoke("get_info");
    } catch (err) {
      showToast("Could not start Media Notepad: " + err);
      return;
    }

    await refreshNotes();

    const lastId = localStorage.getItem(LAST_NOTE_KEY);
    const target = state.notes.find((n) => n.id === lastId) || state.notes[0];

    if (target) {
      await openNote(target.id);
    } else {
      await createNote();
    }

    updateStatus();
    els.editor.focus();
  }

  boot();
})();
