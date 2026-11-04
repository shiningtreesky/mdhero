import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { pageWindowSize, type PageWindowInput } from "$lib/utils/page";

/** Resize the window to exactly fit the A4 sheet, and optionally center it
 *  again — a window that grows by 776px is no longer where it was placed. */
export function fitWindowToPage(
  input: Omit<PageWindowInput, "available">,
  center = false,
): void {
  // `pnpm dev` also serves the app in a plain browser, where there is no window
  // to size. Same host check i18n uses before touching the Tauri bridge.
  if (!("__TAURI_INTERNALS__" in window)) return;
  const size = pageWindowSize({
    ...input,
    available: { width: window.screen.availWidth, height: window.screen.availHeight },
  });
  const win = getCurrentWindow();
  let sized: Promise<void> = win.setSize(new LogicalSize(size.width, size.height));
  if (center) sized = sized.then(() => win.center());
  void sized.catch(() => {});
}
