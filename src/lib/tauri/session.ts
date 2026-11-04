import { get } from "svelte/store";
import { tabStore } from "../stores/tabs";
import { rightPaneOpen } from "../stores/panes";
import { openFile, pathExists } from "./files";

/**
 * Reopen the previous run's tabs (#72): same files, same order, same active
 * tab, and the right column's files back in the right column. Files that no
 * longer exist are skipped silently, and a file that fails to open does not
 * stop the rest. Returns how many tabs came back.
 *
 * Runs before any "Open With" / CLI file so that one lands on top, active, the
 * way a browser handles a link clicked while it restores a session.
 */
export async function restoreSession(): Promise<number> {
  const saved = tabStore.getSavedSession();
  if (!saved || (saved.paths.length === 0 && (saved.rightPaths?.length ?? 0) === 0)) return 0;

  const open = async (path: string): Promise<boolean> => {
    try {
      if (!(await pathExists(path))) return false;
      await openFile(path);
      return true;
    } catch {
      return false;
    }
  };

  let restored = 0;
  for (const path of saved.paths) {
    if (await open(path)) restored++;
  }

  // `openFile` hands each document to the column being worked in, so a right
  // column tab has to be moved once it has come back.
  for (const path of saved.rightPaths ?? []) {
    if (!(await open(path))) continue;
    restored++;
    const tab = get(tabStore.tabs).find((t) => t.filePath === path);
    if (tab) tabStore.moveTabToPane(tab.id, "right");
  }
  if (saved.rightOpen) rightPaneOpen.set(true);

  if (restored === 0) return 0;

  const tabs = get(tabStore.tabs);
  const active = saved.activePath ? tabs.find((t) => t.filePath === saved.activePath) : undefined;
  if (active) {
    tabStore.switchTab(active.id);
  } else if (saved.activePath === null) {
    tabStore.goHome();
  }
  // Else: the active file is gone; stay on the last one that came back.
  return restored;
}
