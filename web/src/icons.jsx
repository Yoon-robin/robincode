// Line icons, drawn like RobinAI's (24px box, 1.8 stroke, round ends).
const PATHS = {
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  down: "M12 5v14M6 13l6 6 6-6",
  edit: "M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3zM13.5 7.5l3 3",
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
