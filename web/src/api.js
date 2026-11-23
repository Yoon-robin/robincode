// Talking to server.mjs: the token comes after the # in the window's address
// (kept in sessionStorage so a reload still has it), POSTs carry it in a
// header, the event stream (EventSource cannot set headers) in ?t=.

let token = (location.hash.match(/t=([\w-]+)/) || [])[1];
try {
  if (token) sessionStorage.setItem("robincode-token", token);
  else token = sessionStorage.getItem("robincode-token");
} catch { /* storage off: the address still has it */ }
// opened first without the token (a plain address), then given it after the #
window.addEventListener("hashchange", () => location.reload());

// a sent picture, by its id (the list of messages carries the id, not the picture)
export const picUrl = (id) => `/api/pic/${id}?t=${encodeURIComponent(token || "")}`;

// the folder screen (web/picker, served at /picker/), in this same window
export const pickerUrl = () => `/picker/?t=${encodeURIComponent(token || "")}`;

export async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-robincode-token": token || "" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${path} ${res.status}`), { gpuOff: !!data.gpuOff, moved: !!data.moved, stopped: !!data.stopped, status: res.status });
  return data;
}

// calls onEvent for every server event; onLink(true/false) when the stream
// comes and goes (EventSource reconnects by itself while the server lives)
export function connect(onEvent, onLink) {
  const source = new EventSource(`/api/events?t=${encodeURIComponent(token || "")}`);
  source.onopen = () => onLink(true);
  // The model writes 120-140 tokens a second, each its own event: every one copied the
  // list of messages and drew the answer again (its Markdown parsed from the start). The
  // deltas of one kind that come within a frame go to the window as one (B-439); any
  // other event sends what waits first, so the order is the server's.
  let waiting = null;
  let timer = 0;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!waiting) return;
    const e = waiting;
    waiting = null;
    onEvent(e);
  };
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if ((e.t === "text" || e.t === "thinking") && typeof e.delta === "string") {
      if (waiting && waiting.t === e.t) waiting.delta += e.delta;
      else { flush(); waiting = { ...e }; }
      // a hidden window is drawn by nobody: ten times a second is enough there
      timer ||= setTimeout(flush, document.hidden ? 100 : 16);
      return;
    }
    flush();
    onEvent(e);
  };
  source.onerror = () => onLink(source.readyState === EventSource.OPEN);
  return () => { flush(); source.close(); };
}

// "smooth" unless the system asks for less motion (CSS does not reach scrollTo)
export const glide = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
