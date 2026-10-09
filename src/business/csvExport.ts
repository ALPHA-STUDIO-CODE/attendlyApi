/**
 * Attendee CSV formatting (Phase H5). Pure functions, no I/O.
 *
 * Output is built for people opening the file in a spreadsheet:
 * - UTF-8 with a BOM, because Excel otherwise tends to misread non-ASCII
 *   names (e.g. "José"),
 * - CRLF line endings (RFC 4180),
 * - every cell neutralised against spreadsheet formula injection, since
 *   names are user-supplied and the file is opened by someone else.
 */

const UTF8_BOM = "\uFEFF";
const LINE_BREAK = "\r\n";

// A cell starting with any of these can be interpreted as a formula by
// spreadsheet software (OWASP "CSV Injection").
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export const ATTENDEE_CSV_HEADERS = [
  "Name",
  "Email",
  "Status",
  "Waitlist position",
  "Registered at",
  "Checked in at",
] as const;

export interface AttendeeCsvRow {
  name: string;
  email: string;
  status: string;
  waitlistPosition: number | null;
  createdAt: Date;
  checkedInAt: Date | null;
}

/**
 * Makes one value safe to place in a CSV cell: first neutralises a leading
 * formula character by prefixing an apostrophe, then applies RFC 4180
 * quoting if the result contains a comma, quote, or line break.
 */
export function escapeCsvCell(value: string): string {
  const neutralised = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

function toCells(row: AttendeeCsvRow): string[] {
  return [
    row.name,
    row.email,
    row.status,
    row.waitlistPosition === null ? "" : String(row.waitlistPosition),
    row.createdAt.toISOString(),
    row.checkedInAt === null ? "" : row.checkedInAt.toISOString(),
  ];
}

/**
 * Formats attendees as CSV text: BOM, header row, then one row per attendee
 * in the order given, each line ending in CRLF. An empty list yields just
 * the header row. Deliberately has no field for a ticket token — the QR
 * secret must never end up in a file that gets emailed around.
 */
export function formatAttendeesCsv(rows: AttendeeCsvRow[]): string {
  const lines = [
    [...ATTENDEE_CSV_HEADERS].map(escapeCsvCell).join(","),
    ...rows.map((row) => toCells(row).map(escapeCsvCell).join(",")),
  ];
  return UTF8_BOM + lines.join(LINE_BREAK) + LINE_BREAK;
}

const MAX_SLUG_LENGTH = 40;

/**
 * Builds a filename that is safe to put in a Content-Disposition header: the
 * event title reduced to lowercase letters, digits and hyphens (accents
 * stripped), never the raw title. Falls back to the event id when nothing
 * usable is left (e.g. a title in a non-Latin script).
 */
export function buildAttendeesCsvFilename(title: string, eventId: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return `attendees-${slug || eventId}.csv`;
}
