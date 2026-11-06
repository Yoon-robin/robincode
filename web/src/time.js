import { useEffect, useState } from "react";

// re-renders every `ms` while mounted, for counters
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function seconds(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function ago(time, now = Date.now()) {
  const m = Math.floor((now - time) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  const date = new Date(time);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
