# Note Replay

> Record and replay your note editing process.
## Core Features

- **Edit Snapshots**: Automatically records a text snapshot at most every 600ms while editing notes.
- **Replay Panel**: Press `Ctrl + Alt + G` (or `Cmd + Option + G`) to open/close the replay panel for the current note.
- **Scrubbing & Playback Speed**: Drag the progress bar to review any past edit, with playback speeds ranging from `0.5x` to `16x`.
- **Export & Delete**: In the top right corner of the replay panel, you can export all history of the current note as a JSON file or clear the snapshots for just this note.
- **Excluded Folders**: You can specify certain folders in the settings (e.g., "Private Diary", "Temp Clipboard") where no snapshots will be recorded.
- **Smart Storage Optimization**:
  - **Expiration**: Snapshots are retained for only 7 days. Expired data is automatically cleaned up on startup and every hour.
  - **Equidistant Thinning**: A maximum of 1000 records are kept per note. When exceeded, old snapshots are deleted **at regular intervals** across the entire time range (keeping the first and last ones), ensuring early records are not completely lost.

## Installation

### Method 1: Obsidian Community Plugins
1. Open Obsidian Settings -> Community Plugins -> Browse.
2. Search for `Note Replay` and install/enable it.

### Method 2: Manual Installation
1. Download the latest `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/QQpigeonia0706/note-replay/releases/tag/1.0.3) page of this repository.
2. In your Vault folder, locate the `.obsidian/plugins/` directory (create it manually if it doesn't exist).
3. Create a new folder named `note-replay` and place the three downloaded files inside it.
4. Open Obsidian, turn off Safe Mode in "Community Plugins", refresh, and enable `Note Replay`.

## Usage

| Action | Description |
| --- | --- |
| Writing normally | The plugin records automatically in the background; no intervention needed |
| `Ctrl + Alt + G` | Open/close the replay panel for the current note |
| `Space` | Play / Pause replay |
| `←` / `→` | Step backward / forward |
| `⏮` / `⏭` Buttons | Jump to start / Jump to latest state |
| Progress bar | Drag to any historical moment |
| Top right `⬇ Export` | Export the edit history of the current note as JSON |
| Top right `🗑 Delete All` | Clear all snapshots of the current note (does not affect note content) |

## Settings & Data

In **Settings -> Note Replay**, you can view current storage usage, snapshot counts for each note, and perform manual cleanups.

**Excluded Folders**:
Enter folder names in the settings (one per line). No snapshots will be recorded for notes in these folders. If snapshots were previously recorded, you can click "Clean Up Now" to delete them all.

## Developer Notes

If you clone the source code of this repository, you need to run `npm run build` to generate `main.js`. Note that the compiled `main.js` and `styles.css` are not in this repository; they are uploaded as binary attachments to [Releases](https://github.com/QQpigeonia0706/note-replay/releases/tag/1.0.3).

## License

This project is open-sourced under the [MIT License](LICENSE).

# Note Replay

> 记录笔记编辑回放。
## 核心功能

- **编辑快照**：编辑笔记时，最多每 600ms 记录一次文字版本快照。
- **回放面板**：按下快捷键 `Ctrl + Alt + G`（或 `Cmd + Option + G`），打开/关闭当前笔记的回放面板。
- **拖动与倍速**：可以拖动进度条回看任意一步的修改，支持 `0.5x` 到 `16x` 倍速播放。
- **导出与删除**：在回放面板右上角，支持一键将当前笔记的所有历史导出为 JSON 文件，或单独清空当前笔记的快照。
- **例外分区**：在设置中可以指定某些文件夹（如“私人日记”、“临时剪贴板”）不记录任何快照。
- **智能存储优化**：
  - **过期快照**：所有快照仅保留 7 天，启动时和每小时自动清理过期数据。
  - **等间隔抽稀**：单篇笔记最多保留 1000 条记录。超出时，会在完整时间区间内**等间距**删除旧快照（首尾保留），不会导致早期记录全部丢失。

## 安装方法

### 方法一：Obsidian 社区市场
1. 打开 Obsidian 设置 -> 第三方插件 -> 社区插件市场。
2. 搜索 `Note Replay` 并安装启用。

### 方法二：手动安装
1. 在本仓库的 [Releases](https://github.com/QQpigeonia0706/note-replay/releases/tag/1.0.3)页面下载最新的 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的 Vault 文件夹中，找到 `.obsidian/plugins/` 目录（如果没有则手动创建）。
3. 新建一个名为 `note-replay` 的文件夹，将下载的三个文件放入其中。
4. 打开 Obsidian，在“第三方插件”中关闭安全模式，刷新并开启 `Note Replay`。

## 使用说明

| 操作 | 说明 |
| --- | --- |
| 正常写笔记 | 插件会在后台自动记录，无需干预 |
| `Ctrl + Alt + G` | 打开/关闭当前笔记的回放面板 |
| `空格键` | 播放 / 暂停回放 |
| `←` / `→` | 单步后退 / 前进 |
| `⏮` / `⏭` 按钮 | 跳回起点 / 跳到最新状态 |
| 进度条 | 任意拖动到某个历史时刻 |
| 右上角 `⬇ 导出` | 导出当前笔记的编辑历史为 JSON |
| 右上角 `🗑 删除全部` | 清空当前笔记的所有快照（不影响笔记内容） |

## 设置与数据

在 **设置 -> Note Replay** 中可以查看当前占用的存储空间、各笔记的快照数量，并进行手动清理。

**例外分区**：
在设置里输入文件夹名称（每行一个），该文件夹下的所有笔记将不再记录任何快照。如果之前已经记录了，可以点击“立即清理”一键删除。

## 开发者说明

如果你克隆了本仓库的源码，需要通过 `npm run build` 构建生成 `main.js`。请注意，编译生成的 `main.js` 和 `styles.css` 不在本仓库中，而是作为二进制附件上传至 [Releases]([链接到你的Releases页面](https://github.com/QQpigeonia0706/note-replay/releases/tag/1.0.3))。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
