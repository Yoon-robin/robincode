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

// the folder screen (web/picker, served at /picker/), in this same window
export const pickerUrl = () => `/picker/?t=${encodeURIComponent(token || "")}`;

export async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-robincode-token": token || "" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${path} ${res.status}`), { gpuOff: !!data.gpuOff });
  return data;
}

// calls onEvent for every server event; onLink(true/false) when the stream
// comes and goes (EventSource reconnects by itself while the server lives)
export function connect(onEvent, onLink) {
  const source = new EventSource(`/api/events?t=${encodeURIComponent(token || "")}`);
  source.onopen = () => onLink(true);
  source.onmessage = (m) => onEvent(JSON.parse(m.data));
  source.onerror = () => onLink(source.readyState === EventSource.OPEN);
  return () => source.close();
}
