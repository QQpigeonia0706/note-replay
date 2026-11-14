'use strict';

const { Plugin, Modal, Setting, Notice, PluginSettingTab } = require('obsidian');

/* ==================== 常量 ==================== */
const DB_NAME = 'note-replay-db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_INTERVAL = 600;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_NOTE = 1000;
const MAX_CONTENT_LENGTH = 500000;

const DEFAULT_SETTINGS = {
  defaultSpeed: 16,
  excludedFolders: [],
};

/* ==================== IndexedDB 存储层 ==================== */
class SnapshotStore {
  constructor() {
    this.db = null;
    this._opening = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('notePath', 'notePath', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('notePath_timestamp', ['notePath', 'timestamp'], { unique: false });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => { this._opening = null; reject(req.error); };
    });
    return this._opening;
  }

  async add(notePath, content, timestamp = Date.now()) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add({ notePath, timestamp, content });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getForNote(notePath) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('notePath').getAll(notePath);
      req.onsuccess = () => {
        const arr = req.result || [];
        arr.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
        resolve(arr);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async countForNote(notePath) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('notePath').count(notePath);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllNotePaths() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('notePath').openKeyCursor(null, 'nextunique');
      const set = new Set();
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { set.add(cursor.key); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(Array.from(set));
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 等间隔抽稀：数量超过 MAX_PER_NOTE 时，在完整时间区间内均匀采样，
   * 保留 MAX_PER_NOTE 条样本，首尾都保留（不截断前后片段）。
   * 用游标遍历 + 索引判断，避免一次性把所有内容读进内存。
   */
  async trimNote(notePath) {
    const total = await this.countForNote(notePath);
    if (total <= MAX_PER_NOTE) return;

    const N = total;
    const M = MAX_PER_NOTE;
    const keepIdx = new Set();
    if (M === 1) {
      keepIdx.add(N - 1);
    } else {
      for (let k = 0; k < M; k++) {
        keepIdx.add(Math.round((k * (N - 1)) / (M - 1)));
      }
    }

    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('notePath_timestamp');
      const range = IDBKeyRange.bound([notePath, 0], [notePath, Number.MAX_SAFE_INTEGER]);
      let i = 0;
      const req = index.openCursor(range, 'next');
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          if (!keepIdx.has(i)) cursor.delete();
          i++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteNote(notePath) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.index('notePath').openKeyCursor(notePath);
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async renameNote(oldPath, newPath) {
    const db = await this.open();
    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('notePath').getAll(oldPath);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (items.length === 0) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const it of items) { it.notePath = newPath; store.put(it); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async cleanup() {
    const db = await this.open();
    const cutoff = Date.now() - RETENTION_MS;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).index('timestamp')
        .openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const paths = await this.getAllNotePaths();
    for (const p of paths) await this.trimNote(p);
  }

  async clearAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async stats() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async detailedStats() {
    const db = await this.open();
    const cutoff = Date.now() - RETENTION_MS;
    const counts = new Map();
    let totalChars = 0;
    let expiredCount = 0;
    let total = 0;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          const it = cursor.value;
          total++;
          counts.set(it.notePath, (counts.get(it.notePath) || 0) + 1);
          totalChars += (it.content || '').length;
          if (it.timestamp < cutoff) expiredCount++;
          cursor.continue();
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const noteCounts = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    return { total, totalChars, expiredCount, noteCounts };
  }
}

/* ==================== 回放面板 ==================== */
class ReplayModal extends Modal {
  constructor(app, plugin, notePath, snapshots) {
    super(app);
    this.plugin = plugin;
    this.notePath = notePath;
    this.snapshots = snapshots;
    this.index = snapshots.length - 1;
    this.speed = plugin.settings.defaultSpeed || 16;
    this.playing = false;
    this.timer = null;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.classList.add('note-replay-modal');
    modalEl.tabIndex = -1;
    contentEl.empty();

    /* 头部：标题 + 快照数 + 导出/删除按钮 */
    const header = contentEl.createDiv({ cls: 'nr-header' });
    header.createSpan({ text: this.notePath, cls: 'nr-title' });

    const headerRight = header.createDiv({ cls: 'nr-header-right' });
    headerRight.createSpan({ text: `${this.snapshots.length} 个快照`, cls: 'nr-count' });

    const exportBtn = headerRight.createEl('button', { text: '⬇ 导出', cls: 'nr-header-btn' });
    exportBtn.title = '导出当前笔记的全部快照为 JSON 文件';
    const deleteBtn = headerRight.createEl('button', { text: '🗑 删除全部', cls: 'nr-header-btn nr-danger' });
    deleteBtn.title = '删除当前笔记的全部快照';

    exportBtn.addEventListener('click', () => this.exportSnapshots());
    deleteBtn.addEventListener('click', () => this.deleteAllSnapshots());

    /* 内容预览 */
    this.previewEl = contentEl.createEl('pre', { cls: 'nr-preview' });

    /* 进度条 */
    this.slider = contentEl.createEl('input', { type: 'range', cls: 'nr-slider' });
    this.slider.min = '0';
    this.slider.max = String(Math.max(0, this.snapshots.length - 1));
    this.slider.value = String(this.index);

    const infoRow = contentEl.createDiv({ cls: 'nr-info' });
    this.timeLabel = infoRow.createSpan();
    this.gapLabel = infoRow.createSpan({ cls: 'nr-gap' });
    this.sizeLabel = infoRow.createSpan();

    const btnRow = contentEl.createDiv({ cls: 'nr-buttons' });
    const firstBtn = btnRow.createEl('button', { text: '⏮' });
    firstBtn.title = '回到开头';
    const prevBtn = btnRow.createEl('button', { text: '◀' });
    prevBtn.title = '上一步';
    this.playBtn = btnRow.createEl('button', { text: '▶ 播放', cls: 'nr-play-btn' });
    const nextBtn = btnRow.createEl('button', { text: '▶' });
    nextBtn.title = '下一步';
    const lastBtn = btnRow.createEl('button', { text: '⏭' });
    lastBtn.title = '跳到结尾';

    const speedWrap = btnRow.createSpan({ cls: 'nr-speed' });
    speedWrap.createSpan({ text: '倍速 ' });
    this.speedSel = speedWrap.createEl('select');
    [0.5, 1, 2, 4, 8, 16].forEach((s) => {
      const opt = this.speedSel.createEl('option', { text: `${s}x` });
      opt.value = String(s);
    });
    this.speedSel.value = String(this.speed);

    this.slider.addEventListener('input', () => {
      this.pause();
      this.index = parseInt(this.slider.value, 10) || 0;
      this.updateDisplay();
    });
    firstBtn.addEventListener('click', () => {
      this.pause(); this.index = 0; this.updateDisplay();
    });
    prevBtn.addEventListener('click', () => {
      this.pause(); this.index = Math.max(0, this.index - 1); this.updateDisplay();
    });
    nextBtn.addEventListener('click', () => {
      this.pause(); this.index = Math.min(this.snapshots.length - 1, this.index + 1); this.updateDisplay();
    });
    lastBtn.addEventListener('click', () => {
      this.pause(); this.index = this.snapshots.length - 1; this.updateDisplay();
    });
    this.playBtn.addEventListener('click', () => this.togglePlay());

    this.speedSel.addEventListener('change', () => {
      this.speed = parseFloat(this.speedSel.value) || 1;
      this.plugin.settings.defaultSpeed = this.speed;
      this.plugin.saveData(this.plugin.settings);
      if (this.playing) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.scheduleNext();
      }
    });

    modalEl.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'SELECT') return;
      if (e.target && e.target.tagName === 'INPUT' && e.target !== this.slider) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault(); this.togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); this.pause();
        this.index = Math.max(0, this.index - 1); this.updateDisplay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); this.pause();
        this.index = Math.min(this.snapshots.length - 1, this.index + 1); this.updateDisplay();
      }
    });

    this.updateDisplay();
    setTimeout(() => modalEl.focus(), 0);
  }

  updateDisplay() {
    if (this.index < 0) this.index = 0;
    if (this.index >= this.snapshots.length) this.index = this.snapshots.length - 1;
    const snap = this.snapshots[this.index];
    if (!snap) return;
    this.previewEl.textContent = snap.content;
    this.slider.value = String(this.index);
    const d = new Date(snap.timestamp);
    this.timeLabel.textContent = `${d.toLocaleString()}　第 ${this.index + 1} / ${this.snapshots.length} 步`;
    if (this.index > 0) {
      const gap = snap.timestamp - this.snapshots[this.index - 1].timestamp;
      this.gapLabel.textContent = `间隔 ${gap}ms`;
    } else {
      this.gapLabel.textContent = '起点';
    }
    this.sizeLabel.textContent = `${snap.content.length} 字符`;
  }

  togglePlay() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (this.snapshots.length < 2) return;
    if (this.index >= this.snapshots.length - 1) this.index = 0;
    this.playing = true;
    this.playBtn.textContent = '⏸ 暂停';
    this.updateDisplay();
    this.scheduleNext();
  }

  pause() {
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.playBtn) this.playBtn.textContent = '▶ 播放';
  }

  scheduleNext() {
    if (!this.playing) return;
    const next = this.index + 1;
    if (next >= this.snapshots.length) {
      this.playing = false;
      if (this.playBtn) this.playBtn.textContent = '▶ 播放';
      return;
    }
    const cur = this.snapshots[this.index];
    const nxt = this.snapshots[next];
    const realGap = Math.max(1, nxt.timestamp - cur.timestamp);

    let delay;
    if (this.speed >= 8) {
      delay = 320 / this.speed;
    } else {
      delay = realGap / this.speed;
    }
    delay = Math.max(16, Math.min(delay, 2000));

    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.playing) return;
      this.index = next;
      this.updateDisplay();
      this.scheduleNext();
    }, delay);
  }

  /* ---------- 导出 / 删除 ---------- */

  exportSnapshots() {
    try {
      const data = {
        notePath: this.notePath,
        exportedAt: new Date().toISOString(),
        count: this.snapshots.length,
        snapshots: this.snapshots.map((s) => ({
          timestamp: s.timestamp,
          timeReadable: new Date(s.timestamp).toLocaleString(),
          content: s.content,
        })),
      };
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const base = (this.notePath.split('/').pop() || 'note').replace(/\.md$/, '');
      const date = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}-快照-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      new Notice(`已导出 ${this.snapshots.length} 条快照`);
    } catch (e) {
      new Notice('导出失败：' + e.message);
    }
  }

  async deleteAllSnapshots() {
    const ok = window.confirm(
      `确定删除「${this.notePath}」的全部 ${this.snapshots.length} 条快照吗？\n此操作不可恢复（笔记文件本身不受影响）。`
    );
    if (!ok) return;
    try {
      await this.plugin.store.deleteNote(this.notePath);
      this.plugin.lastSaved.delete(this.notePath);
      new Notice('已删除该笔记的全部快照');
      this.close();
    } catch (e) {
      new Notice('删除失败：' + e.message);
    }
  }

  onClose() { this.pause(); this.contentEl.empty(); }
}

/* ==================== 设置页 ==================== */
class NoteReplaySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Note Replay 设置' });

    /* ========== 储存状态 ========== */
    const statsBox = containerEl.createDiv({ cls: 'nr-stats-box' });
    statsBox.createEl('h3', { text: '储存状态' });
    const statsEl = statsBox.createEl('p', { text: '读取中…' });

    let stats;
    try {
      stats = await this.plugin.store.detailedStats();
    } catch (e) {
      statsEl.setText('读取失败：' + e.message);
      stats = null;
    }

    if (stats) {
      const kb = (stats.totalChars / 1024).toFixed(1);
      statsEl.empty();
      statsEl.createDiv({ text: `总快照数：${stats.total} 条` });
      statsEl.createDiv({ text: `估算占用：${stats.totalChars.toLocaleString()} 字符（约 ${kb} KB）` });
      const expiredLine = statsEl.createDiv({
        text: `过期待清理（超过 7 天）：${stats.expiredCount} 条`,
      });
      if (stats.expiredCount > 0) expiredLine.style.color = 'var(--text-warning)';

      if (stats.noteCounts.length > 0) {
        const listWrap = statsBox.createDiv({ cls: 'nr-note-list' });
        listWrap.createDiv({ text: '各笔记快照数：', cls: 'nr-note-list-title' });
        const ul = listWrap.createEl('ul');
        const maxShow = 20;
        const shown = stats.noteCounts.slice(0, maxShow);
        for (const [path, n] of shown) {
          const li = ul.createEl('li');
          const overLimit = n >= MAX_PER_NOTE;
          const excluded = this.plugin.isExcluded(path);
          const nameSpan = li.createSpan({ text: path });
          if (overLimit) nameSpan.style.color = 'var(--text-error)';
          if (excluded) nameSpan.style.color = 'var(--text-muted)';
          let suffix = ` — ${n} 条`;
          if (overLimit) suffix += '（已达 1000 条上限，旧记录会被等间隔抽稀）';
          if (excluded) suffix += '（位于例外分区）';
          li.createSpan({ text: suffix });
        }
        if (stats.noteCounts.length > maxShow) {
          ul.createEl('li', { text: `…还有 ${stats.noteCounts.length - maxShow} 篇笔记未显示` });
        }
      } else {
        statsBox.createEl('p', { text: '这里似乎什么也没有。去写个笔记试试看吧。' });
      }
    }

    /* ========== 例外分区 ========== */
    containerEl.createEl('h3', { text: '例外分区' });
    containerEl.createEl('p', {
      text: '下面填写的文件夹内的笔记不会保存任何快照。每行一个路径（相对于仓库根目录，例如 "私人" 或 "Archive/临时"）。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('不记录快照的文件夹')
      .setDesc('每行一个。修改后立即生效（已有的快照不会自动删除，可用下方按钮清理）。')
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
        text.inputEl.style.width = '100%';
        text.setPlaceholder('例如：\n私人\nArchive/临时\nDiary/2024');
        text.setValue((this.plugin.settings.excludedFolders || []).join('\n'));
        text.onChange(async (value) => {
          this.plugin.settings.excludedFolders = value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName('清理例外分区的已有快照')
      .setDesc('删除例外分区文件夹里所有笔记已保存的快照（不影响笔记文件本身）。')
      .addButton((btn) =>
        btn.setButtonText('立即清理').onClick(async () => {
          const folders = this.plugin.settings.excludedFolders || [];
          if (folders.length === 0) {
            new Notice('例外分区为空，无需清理');
            return;
          }
          const paths = await this.plugin.store.getAllNotePaths();
          let count = 0;
          for (const p of paths) {
            if (this.plugin.isExcluded(p)) {
              await this.plugin.store.deleteNote(p);
              this.plugin.lastSaved.delete(p);
              count++;
            }
          }
          new Notice(`已清理 ${count} 篇笔记的快照`);
          this.display();
        })
      );

    /* ========== 储存规则 ========== */
    containerEl.createEl('h3', { text: '储存规则' });
    new Setting(containerEl)
      .setName('快照频率')
      .setDesc('编辑时最多每 600ms 记一条（连续打字会被节流，避免爆炸）。');
    new Setting(containerEl)
      .setName('保留时长')
      .setDesc('每条快照保留 7 天，启动时 + 每小时自动清理过期记录。');
    new Setting(containerEl)
      .setName('单篇上限')
      .setDesc('每篇笔记最多 1000 条。超过时在完整时间区间内等间隔抽稀保留 1000 条，首尾都保留，不会截断前后片段。');

    /* ========== 手动操作 ========== */
    containerEl.createEl('h3', { text: '手动操作' });

    new Setting(containerEl)
      .setName('立即清理')
      .setDesc('马上执行一次：删 7 天前的记录 + 每篇超 1000 条时等间隔抽稀。')
      .addButton((btn) =>
        btn.setButtonText('立即清理').onClick(async () => {
          await this.plugin.store.cleanup();
          new Notice('清理完成');
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('清除所有快照')
      .setDesc('删除全部笔记的编辑历史，不可恢复。')
      .addButton((btn) =>
        btn.setButtonText('清除全部').onClick(async () => {
          await this.plugin.store.clearAll();
          this.plugin.lastSaved.clear();
          new Notice('已清除所有快照');
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('默认回放倍速')
      .setDesc(`当前默认 ${this.plugin.settings.defaultSpeed}x。每次在回放面板里改倍速后，这里会自动记住。`)
      .addButton((btn) =>
        btn.setButtonText('重置为 16x').onClick(async () => {
          this.plugin.settings.defaultSpeed = 16;
          await this.plugin.saveData(this.plugin.settings);
          new Notice('默认倍速已重置为 16x');
          this.display();
        })
      );
  }
}

/* ==================== 主插件 ==================== */
class NoteReplayPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.store = new SnapshotStore();
    this.lastSaved = new Map();
    this.timers = new Map();
    this.pending = new Map();

    await this.store.open();
    this.cleanup();
    this.registerInterval(window.setInterval(() => this.cleanup(), 60 * 60 * 1000));

    this.addCommand({
      id: 'open-note-replay',
      name: '打开笔记回放面板',
      hotkeys: [{ modifiers: ['Ctrl', 'Alt'], key: 'G' }],
      callback: () => this.openReplayPanel(),
    });

    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        this.handleEditorChange(editor, info);
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && file.extension === 'md') this.recordBaseline(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (!file || file.extension !== 'md') return;
        try {
          await this.store.renameNote(oldPath, file.path);
          const last = this.lastSaved.get(oldPath);
          if (last) {
            this.lastSaved.delete(oldPath);
            this.lastSaved.set(file.path, last);
          }
        } catch (e) { console.error('[Note Replay] 重命名失败', e); }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', async (file) => {
        if (!file || file.extension !== 'md') return;
        try {
          await this.store.deleteNote(file.path);
          this.lastSaved.delete(file.path);
        } catch (e) { console.error('[Note Replay] 删除失败', e); }
      })
    );

    this.addSettingTab(new NoteReplaySettingTab(this.app, this));
  }

  onunload() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.store && this.store.db) {
      try { this.store.db.close(); } catch (e) { /* ignore */ }
    }
  }

  async cleanup() {
    try { await this.store.cleanup(); }
    catch (e) { console.error('[Note Replay] 清理失败', e); }
  }

  /* 判断某个笔记路径是否位于例外分区 */
  isExcluded(path) {
    if (!path) return false;
    const folders = this.settings.excludedFolders || [];
    for (const raw of folders) {
      const f = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
      if (!f) continue;
      if (path === f || path.startsWith(f + '/')) return true;
    }
    return false;
  }

  handleEditorChange(editor, info) {
    const file = info && info.file;
    if (!file || file.extension !== 'md') return;
    const path = file.path;

    // 例外分区：不记录，顺便清掉可能残留的 pending
    if (this.isExcluded(path)) {
      this.pending.delete(path);
      return;
    }

    let content;
    try { content = editor.getValue(); } catch (e) { return; }
    if (typeof content !== 'string') return;
    if (content.length > MAX_CONTENT_LENGTH) return;

    this.pending.set(path, content);

    const last = this.lastSaved.get(path);
    const now = Date.now();
    const elapsed = last ? now - last.time : Infinity;

    if (elapsed >= SNAPSHOT_INTERVAL) {
      this.flush(path);
    } else if (!this.timers.has(path)) {
      const delay = SNAPSHOT_INTERVAL - elapsed;
      const timer = window.setTimeout(() => {
        this.timers.delete(path);
        this.flush(path);
      }, delay);
      this.timers.set(path, timer);
    }
  }

  async flush(path) {
    const content = this.pending.get(path);
    if (content === undefined) return;
    this.pending.delete(path);

    if (this.isExcluded(path)) return;

    const last = this.lastSaved.get(path);
    if (last && last.content === content) return;

    const now = Date.now();
    this.lastSaved.set(path, { time: now, content });

    try {
      await this.store.add(path, content, now);
      await this.store.trimNote(path);   // 内部会先 count，未超限直接返回
    } catch (e) {
      console.error('[Note Replay] 保存失败', e);
    }
  }

  async recordBaseline(file) {
    if (this.isExcluded(file.path)) return;
    try {
      const snaps = await this.store.getForNote(file.path);
      if (snaps.length > 0) {
        const last = snaps[snaps.length - 1];
        this.lastSaved.set(file.path, { time: last.timestamp, content: last.content });
        return;
      }
      const content = await this.app.vault.cachedRead(file);
      if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) return;
      const now = Date.now();
      await this.store.add(file.path, content, now);
      this.lastSaved.set(file.path, { time: now, content });
    } catch (e) {
      console.error('[Note Replay] 记录基线失败', e);
    }
  }

  async openReplayPanel() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('请先打开一个 Markdown 笔记');
      return;
    }

    try { await this.flush(file.path); } catch (e) { /* ignore */ }

    let snaps = [];
    try {
      snaps = await this.store.getForNote(file.path);
    } catch (e) {
      new Notice('读取快照失败：' + e.message);
      return;
    }

    if (snaps.length === 0) {
      new Notice('这篇笔记还没有快照。');
      return;
    }

    new ReplayModal(this.app, this, file.path, snaps).open();
  }
}

module.exports = NoteReplayPlugin;
