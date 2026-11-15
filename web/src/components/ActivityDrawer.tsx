import { Link } from "react-router-dom";
import { TENANT_ID } from "../api/client";
import type { ActivityEvent, ServiceHealth } from "../api/types";
import { formatClock, shortId } from "../lib/format";
import { useNow } from "../lib/hooks";
import { healthDotClass, SERVICES } from "../lib/health";
import { useServiceHealth } from "../live/useServiceHealth";
import { useLive } from "../live/LiveEvents";
import { ChevronRightIcon } from "./Icons";
import { Dot, LivePill } from "./ui";

/** Topics the gateway's activity consumer subscribes to. */
const TOPICS = ["rfq.events", "bid.events"];

const STATUS_WORD: Record<ServiceHealth["status"], string> = {
  healthy: "healthy",
  degraded: "degraded",
  down: "unreachable",
};

function HealthCard({ name, health }: { name: ServiceHealth["name"]; health: ServiceHealth | undefined }) {
  const tone =
    health?.status === "down"
      ? "border-bad/30 bg-bad-soft"
      : health?.status === "degraded"
        ? "border-warn/40 bg-warn-soft"
        : "bg-surface-2";
  const textTone = health?.status === "down" ? "text-bad" : health?.status === "degraded" ? "text-warn" : "text-text-3";
  // healthy → "healthy · p95 42 ms"; degraded → its detail ("lagging · 3.2 s"); down → "unreachable · 3 timeouts"
  const p95 = health?.p95_ms != null ? `p95 ${Math.round(health.p95_ms)} ms` : null;
  const detail = !health
    ? "checking…"
    : health.status === "degraded" && health.detail
      ? health.detail
      : [STATUS_WORD[health.status], health.detail ?? p95].filter(Boolean).join(" · ");
  return (
    <li className={`min-w-0 rounded-lg border px-2.5 py-2 ${tone}`}>
      <div className="flex items-start gap-1.5">
        <Dot className={`mt-[5px] ${healthDotClass(health)}`} />
        <span className="break-words font-mono text-mono text-text [overflow-wrap:anywhere]">{name}</span>
      </div>
      <p className={`mt-0.5 text-caption tabular-nums ${textTone}`}>{detail}</p>
    </li>
  );
}

const TYPE_TONE: Record<string, string> = {
  "rfq.created": "text-accent-text",
  "rfq.awarded": "text-good",
};

function EventRow({ ev }: { ev: ActivityEvent }) {
  const isRfq = ev.key.startsWith("rfq_");
  return (
    <li className="border-b px-4 py-2.5 font-mono text-mono">
      <div className="flex flex-wrap gap-x-2">
        <time dateTime={ev.occurred_at} className="tabular-nums text-text-3">
          {formatClock(ev.occurred_at)}
        </time>
        <span className="text-text-2">{ev.topic}</span>
        <span className={`font-medium ${TYPE_TONE[ev.event_type] ?? "text-text"}`}>{ev.event_type}</span>
      </div>
      <div className="flex gap-2">
        {isRfq ? (
          <Link to={`/rfqs/${ev.key}`} title={ev.key} className="shrink-0 text-accent-text hover:underline">
            {shortId(ev.key)}
          </Link>
        ) : (
          <span className="shrink-0 text-accent-text">{ev.key}</span>
        )}
        <span className="min-w-0 break-words text-text">{ev.summary}</span>
      </div>
    </li>
  );
}

/** System activity: live event feed (newest first) + service health cards. */
export function ActivityDrawer({ id, onCollapse }: { id: string; onCollapse: () => void }) {
  const live = useLive();
  const services = useServiceHealth();
  const now = useNow(1000);
  const retryIn = live.retryAt ? Math.max(0, Math.ceil((live.retryAt - now) / 1000)) : null;

  return (
    <aside id={id} aria-label="System activity" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="px-4 pb-3 pt-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-section">
            System activity <LivePill live={live.status === "live"} compact />
          </h2>
          <button
            type="button"
            onClick={onCollapse}
            className="rounded-md p-1 text-text-2 hover:bg-surface-2 hover:text-text"
            aria-label="Collapse system activity"
          >
            <ChevronRightIcon />
          </button>
        </div>
        <p className="mt-2 font-mono text-mono-xs text-text-3">
          SSE /v1/events · {TENANT_ID} ·{" "}
          <span title={TOPICS.join(", ")}>
            {TOPICS.length} topics
          </span>
        </p>
        <ul className="mt-3 grid grid-cols-3 gap-2" aria-label="Service health">
          {SERVICES.map((name) => (
            <HealthCard key={name} name={name} health={services.get(name)} />
          ))}
        </ul>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t">
        {live.events.length === 0 ? (
          <p className="px-4 py-3 text-caption text-text-2">
            {live.status === "live"
              ? "No events yet. Create an RFQ to see rfq.created arrive here."
              : "Connecting to the event stream…"}
          </p>
        ) : (
          <ol aria-label="Events, newest first">
            {live.events.map((ev) => (
              <EventRow key={ev.event_id} ev={ev} />
            ))}
          </ol>
        )}
      </div>

      <p className="border-t px-4 py-3 font-mono text-mono-xs text-text-3" aria-live="polite">
        {live.status === "reconnecting"
          ? `stream lost · reconnecting${retryIn !== null ? ` in ${retryIn} s` : ""} (attempt ${live.attempt})`
          : live.status === "connecting"
            ? "connecting…"
            : `${live.events.length} events · newest first`}
      </p>
    </aside>
  );
}
