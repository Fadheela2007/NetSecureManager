const COLORS = {
  up: "var(--color-ok)",
  down: "var(--color-crit)",
  inconnu: "var(--color-mute)",
};

export default function StatusDot({ status }) {
  const color = COLORS[status] || COLORS.inconnu;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={status === "up" ? "pulse-dot" : ""}
        style={{
          color,
          width: 7,
          height: 7,
          borderRadius: "9999px",
          backgroundColor: color,
          display: "inline-block",
        }}
      />
    </span>
  );
}