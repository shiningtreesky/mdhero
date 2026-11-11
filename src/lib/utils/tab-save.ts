/** Only the fields Save needs. `Tab` satisfies this structurally. */
export interface SaveableTab {
  filePath: string;
  dirty: boolean;
}

/** A brand-new or pasted document has no location on disk yet: its first save
 *  is a Save As dialog, which is meaningful even before a single character is
 *  typed (and therefore even while `dirty` is still false). Pasted text is
 *  never written anywhere until the reader saves it. */
export function needsSaveAs(tab: SaveableTab | null): boolean {
  return (
    !!tab &&
    (tab.filePath.startsWith("new://") || tab.filePath.startsWith("paste://"))
  );
}

/** Whether the Save button and Cmd+S should do something. A dirty file has
 *  changes to write; a new document always has a location to choose. */
export function canSaveTab(tab: SaveableTab | null): boolean {
  return !!tab && (tab.dirty || needsSaveAs(tab));
}
