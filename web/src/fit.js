// a window taller than the screen has its top (the title, the search box) out
// of sight: Edge opens an app window at the size it was asked for. Fit it in
export function fitWindow() {
  try {
    const s = window.screen;
    const top = s.availTop ?? 0;
    const left = s.availLeft ?? 0;
    const out = window.outerHeight > s.availHeight || window.outerWidth > s.availWidth
      || window.screenY < top || window.screenY + window.outerHeight > top + s.availHeight;
    if (!out) return;
    const w = Math.min(window.outerWidth, s.availWidth);
    const h = Math.min(window.outerHeight, s.availHeight);
    window.resizeTo(w, h);
    window.moveTo(left + Math.round((s.availWidth - w) / 2), top + Math.round((s.availHeight - h) / 2));
  } catch { /* not an app window */ }
}
