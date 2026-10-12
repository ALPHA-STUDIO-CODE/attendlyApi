import { buildAppUrl } from "./appUrl";

// Email content (spec §7.3, §7.5, §8): plain functions returning
// { subject, html, text }, so they are pure, unit-testable and need no
// templating dependency. Every user-supplied value (names, event titles,
// addresses) is HTML-escaped in the HTML part; the text part is plain text.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  venueName: string;
  address: string;
  city: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapses line breaks so user text can't inject extra header lines. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function formatInZone(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  // U+202F (narrow no-break space) before AM/PM, emitted by newer ICU
  // versions, renders oddly in some mail clients: use a plain space.
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone })
    .format(date)
    .replace(/\u202f/g, " ");
}

const DAY: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
};
const TIME: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * "Saturday, November 7, 2026, 6:00 PM EST – 9:00 PM EST", in the event's own
 * timezone (spec: Event.timezone drives display). An end on a later local day
 * repeats the date. An unknown timezone falls back to UTC rather than
 * failing the email.
 */
export function formatEventWhen(
  event: Pick<EmailEvent, "startTime" | "endTime" | "timezone">,
): string {
  const render = (timeZone: string): string => {
    const startDay = formatInZone(event.startTime, timeZone, DAY);
    const endDay = formatInZone(event.endTime, timeZone, DAY);
    const start = `${startDay}, ${formatInZone(event.startTime, timeZone, TIME)}`;
    const endTime = formatInZone(event.endTime, timeZone, TIME);
    return startDay === endDay ? `${start} – ${endTime}` : `${start} – ${endDay}, ${endTime}`;
  };
  try {
    return render(event.timezone);
  } catch {
    return render("UTC");
  }
}

/** "Saturday, November 7, 2026" — the event's start day in its own timezone. */
export function formatEventDay(event: Pick<EmailEvent, "startTime" | "timezone">): string {
  try {
    return formatInZone(event.startTime, event.timezone, DAY);
  } catch {
    return formatInZone(event.startTime, "UTC", DAY);
  }
}

function formatEventWhere(event: Pick<EmailEvent, "venueName" | "address" | "city">): string {
  return `${event.venueName}, ${event.address}, ${event.city}`;
}

function eventUrl(event: Pick<EmailEvent, "id">): string {
  return buildAppUrl(`/events/${encodeURIComponent(event.id)}`);
}

interface Layout {
  heading: string;
  /** Already-escaped HTML paragraphs. */
  paragraphsHtml: string[];
  cta?: { label: string; url: string };
}

function renderHtml({ heading, paragraphsHtml, cta }: Layout): string {
  const body = paragraphsHtml
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.5">${paragraph}</p>`)
    .join("\n    ");
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
    ${body}
    ${button}
    <p style="margin:24px 0 0;font-size:12px;color:#6b7280">Sent by Attendly.</p>
  </div>`;
}

function eventDetailsHtml(event: EmailEvent): string {
  return `<strong>When:</strong> ${escapeHtml(formatEventWhen(event))}<br><strong>Where:</strong> ${escapeHtml(formatEventWhere(event))}`;
}

function eventDetailsText(event: EmailEvent): string {
  return `When: ${formatEventWhen(event)}\nWhere: ${formatEventWhere(event)}`;
}

/**
 * Reminder (spec §7.5). Deliberately says when the event is, never "in N
 * hours": a reminder can go out later than configured (after a restart, or
 * for a reminder added late), and a relative time would then be wrong.
 */
export function eventReminderEmail(data: { userName: string; event: EmailEvent }): EmailContent {
  const { event } = data;
  const name = oneLine(data.userName);
  const url = eventUrl(event);
  return {
    subject: oneLine(`Reminder: ${event.title} on ${formatEventDay(event)}`),
    html: renderHtml({
      heading: "Event reminder",
      paragraphsHtml: [
        `Hi ${escapeHtml(name)}, a reminder that <strong>${escapeHtml(event.title)}</strong> is coming up.`,
        eventDetailsHtml(event),
      ],
      cta: { label: "View event", url },
    }),
    text: [
      `Hi ${name}, a reminder that ${event.title} is coming up.`,
      "",
      eventDetailsText(event),
      "",
      `View event: ${url}`,
    ].join("\n"),
  };
}

export function registrationConfirmationEmail(data: {
  userName: string;
  event: EmailEvent;
}): EmailContent {
  const { event } = data;
  const name = oneLine(data.userName);
  const url = eventUrl(event);
  return {
    subject: oneLine(`You're registered: ${event.title}`),
    html: renderHtml({
      heading: "You're registered",
      paragraphsHtml: [
        `Hi ${escapeHtml(name)}, you're registered for <strong>${escapeHtml(event.title)}</strong>.`,
        eventDetailsHtml(event),
      ],
      cta: { label: "View event", url },
    }),
    text: [
      `Hi ${name}, you're registered for ${event.title}.`,
      "",
      eventDetailsText(event),
      "",
      `View event: ${url}`,
    ].join("\n"),
  };
}

export function waitlistJoinedEmail(data: {
  userName: string;
  event: EmailEvent;
  position: number | null;
}): EmailContent {
  const { event } = data;
  const name = oneLine(data.userName);
  const url = eventUrl(event);
  const standing =
    data.position === null
      ? "You're on the waitlist."
      : `You're number ${data.position} on the waitlist.`;
  return {
    subject: oneLine(`You're on the waitlist: ${event.title}`),
    html: renderHtml({
      heading: "You're on the waitlist",
      paragraphsHtml: [
        `Hi ${escapeHtml(name)}, <strong>${escapeHtml(event.title)}</strong> is full right now. ${escapeHtml(standing)} We'll email you if a spot opens up.`,
        eventDetailsHtml(event),
      ],
      cta: { label: "View event", url },
    }),
    text: [
      `Hi ${name}, ${event.title} is full right now. ${standing} We'll email you if a spot opens up.`,
      "",
      eventDetailsText(event),
      "",
      `View event: ${url}`,
    ].join("\n"),
  };
}

export function waitlistPromotionEmail(data: {
  userName: string;
  event: EmailEvent;
}): EmailContent {
  const { event } = data;
  const name = oneLine(data.userName);
  const url = eventUrl(event);
  return {
    subject: oneLine(`A spot opened up: ${event.title}`),
    html: renderHtml({
      heading: "A spot opened up",
      paragraphsHtml: [
        `Good news, ${escapeHtml(name)} — a spot opened up for <strong>${escapeHtml(event.title)}</strong> and you've moved off the waitlist. You're now registered.`,
        eventDetailsHtml(event),
      ],
      cta: { label: "View event", url },
    }),
    text: [
      `Good news, ${name} — a spot opened up for ${event.title} and you've moved off the waitlist. You're now registered.`,
      "",
      eventDetailsText(event),
      "",
      `View event: ${url}`,
    ].join("\n"),
  };
}

export function eventCancellationEmail(data: {
  userName: string;
  event: EmailEvent;
}): EmailContent {
  const { event } = data;
  const name = oneLine(data.userName);
  const url = eventUrl(event);
  return {
    subject: oneLine(`Cancelled: ${event.title}`),
    html: renderHtml({
      heading: "Event cancelled",
      paragraphsHtml: [
        `Hi ${escapeHtml(name)}, the organizer has cancelled <strong>${escapeHtml(event.title)}</strong>. Your registration or waitlist spot is no longer needed.`,
        `It was scheduled for ${escapeHtml(formatEventWhen(event))}.`,
      ],
      cta: { label: "View event", url },
    }),
    text: [
      `Hi ${name}, the organizer has cancelled ${event.title}. Your registration or waitlist spot is no longer needed.`,
      "",
      `It was scheduled for ${formatEventWhen(event)}.`,
      "",
      `View event: ${url}`,
    ].join("\n"),
  };
}

export function passwordResetEmail(data: { userName: string; resetUrl: string }): EmailContent {
  const name = oneLine(data.userName);
  return {
    subject: "Reset your Attendly password",
    html: renderHtml({
      heading: "Reset your password",
      paragraphsHtml: [
        `Hi ${escapeHtml(name)}, we received a request to reset your Attendly password. This link works once and expires in 1 hour.`,
        "If you didn't ask for this, you can ignore this email — your password won't change.",
      ],
      cta: { label: "Reset password", url: data.resetUrl },
    }),
    text: [
      `Hi ${name}, we received a request to reset your Attendly password. This link works once and expires in 1 hour:`,
      "",
      data.resetUrl,
      "",
      "If you didn't ask for this, you can ignore this email — your password won't change.",
    ].join("\n"),
  };
}
