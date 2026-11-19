// Line icons, drawn like RobinAI's (24px box, 1.8 stroke, round ends).
const PATHS = {
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  down: "M12 5v14M6 13l6 6 6-6",
  left: "M15 6l-6 6 6 6",
  // lucide chevron-down
  chevdown: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  retry: "M20 12a8 8 0 1 1-2.35-5.65M20 4.5v4h-4",
  edit: "M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3zM13.5 7.5l3 3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2",
  image: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16l4.5-4.5 4 4L15 13l5 5M15.5 9h.01",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  // lucide message-square
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  // lucide pin
  pin: "M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  // lucide triangle-alert
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  minus: "M6 12h12",
  // lucide clock
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  // lucide circle-help
  ask: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  // the app's mark: code brackets
  code: "M9 7l-5 5 5 5M15 7l5 5-5 5",
};

export function Icon({ name }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {name === "copy"
        ? <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>
        : <path d={PATHS[name]} />}
    </svg>
  );
}

// A status, said with an icon (brand V3, 2026-11-19: no more "[ OK ]" text on
// screen). The words in the store stay the terminal's; this draws them, and a
// screen reader reads the label.
const TAGS = {
  "[ OK ]": ["ok", "완료", "check"],
  "[FAIL]": ["fail", "실패", "close"],
  "[SKIP]": ["skip", "건너뜀", "minus"],
  "[ .. ]": ["run", "진행 중", null],
  "[ ?? ]": ["ask", "허락을 기다려요", "ask"],
  "[ ·· ]": ["wait", "기다려요", "clock"],
  "[ !! ]": ["warn", "주의", "alert"],
  "[ -- ]": ["none", "없음", "minus"],
  "[NEW]": ["new", "새것", null],
};
export function Tag({ tag }) {
  const [kind, label, icon] = TAGS[tag] || ["none", tag, "minus"];
  if (kind === "new") return <span className="tag tag-new">NEW</span>;
  return (
    <span className={`tag tag-${kind}`} role="img" aria-label={label} title={label}>
      {icon ? <Icon name={icon} /> : <span className="spin" />}
    </span>
  );
}

// RobinCode's mark: a blue square with the code brackets
export function AppMark({ size = "" }) {
  return (
    <span className={`app-mark${size ? ` ${size}` : ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d={PATHS.code} /></svg>
    </span>
  );
}
