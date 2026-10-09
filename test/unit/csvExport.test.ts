import {
  ATTENDEE_CSV_HEADERS,
  buildAttendeesCsvFilename,
  escapeCsvCell,
  formatAttendeesCsv,
  type AttendeeCsvRow,
} from "../../src/business/csvExport";

const BOM = "\uFEFF";

function row(overrides: Partial<AttendeeCsvRow> = {}): AttendeeCsvRow {
  return {
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "REGISTERED",
    waitlistPosition: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    checkedInAt: null,
    ...overrides,
  };
}

describe("escapeCsvCell", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeCsvCell("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("leaves an empty string empty", () => {
    expect(escapeCsvCell("")).toBe("");
  });

  it("leaves non-ASCII text unchanged", () => {
    expect(escapeCsvCell("José Müller 会議")).toBe("José Müller 会議");
  });

  it("quotes a cell containing a comma", () => {
    expect(escapeCsvCell("Lovelace, Ada")).toBe('"Lovelace, Ada"');
  });

  it("quotes a cell containing a double quote and doubles the quote", () => {
    expect(escapeCsvCell('Ada "Countess" Lovelace')).toBe('"Ada ""Countess"" Lovelace"');
  });

  it("quotes a cell containing a line feed", () => {
    expect(escapeCsvCell("Ada\nLovelace")).toBe('"Ada\nLovelace"');
  });

  it("quotes a cell containing a carriage return", () => {
    expect(escapeCsvCell("Ada\rLovelace")).toBe('"Ada\rLovelace"');
  });

  it.each([
    ["=", "=1+1"],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(A1)"],
  ])("neutralises a cell starting with %s by prefixing an apostrophe", (_char, value) => {
    expect(escapeCsvCell(value)).toBe(`'${value}`);
  });

  it("neutralises a cell starting with a tab", () => {
    expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
  });

  it("neutralises a cell starting with a carriage return, then quotes it", () => {
    expect(escapeCsvCell("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("neutralises first, then quotes, when both apply", () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil.example","x")')).toBe(
      '"\'=HYPERLINK(""http://evil.example"",""x"")"',
    );
  });

  it("only looks at the first character, not the middle", () => {
    expect(escapeCsvCell("a=b")).toBe("a=b");
    expect(escapeCsvCell("well-known")).toBe("well-known");
    expect(escapeCsvCell("ada@example.com")).toBe("ada@example.com");
    expect(escapeCsvCell("1+1")).toBe("1+1");
  });
});

describe("formatAttendeesCsv", () => {
  it("starts with a UTF-8 BOM", () => {
    expect(formatAttendeesCsv([]).charAt(0)).toBe(BOM);
  });

  it("produces only the header row for an empty list", () => {
    expect(formatAttendeesCsv([])).toBe(
      `${BOM}Name,Email,Status,Waitlist position,Registered at,Checked in at\r\n`,
    );
  });

  it("uses the documented header columns, in order, and no ticket token column", () => {
    expect([...ATTENDEE_CSV_HEADERS]).toEqual([
      "Name",
      "Email",
      "Status",
      "Waitlist position",
      "Registered at",
      "Checked in at",
    ]);
  });

  it("formats a registered attendee: empty waitlist position, ISO UTC timestamp, empty check-in", () => {
    expect(formatAttendeesCsv([row()])).toBe(
      `${BOM}Name,Email,Status,Waitlist position,Registered at,Checked in at\r\n` +
        "Ada Lovelace,ada@example.com,REGISTERED,,2026-10-01T12:00:00.000Z,\r\n",
    );
  });

  it("formats a waitlisted attendee with their position", () => {
    const csv = formatAttendeesCsv([row({ status: "WAITLISTED", waitlistPosition: 3 })]);

    expect(csv).toContain(
      "Ada Lovelace,ada@example.com,WAITLISTED,3,2026-10-01T12:00:00.000Z,\r\n",
    );
  });

  it("formats a checked-in attendee with the check-in timestamp", () => {
    const csv = formatAttendeesCsv([row({ checkedInAt: new Date("2026-10-02T09:30:00.000Z") })]);

    expect(csv).toContain("REGISTERED,,2026-10-01T12:00:00.000Z,2026-10-02T09:30:00.000Z\r\n");
  });

  it("keeps rows in the order given and ends every line with CRLF", () => {
    const csv = formatAttendeesCsv([
      row({ name: "First" }),
      row({ name: "Second" }),
      row({ name: "Third" }),
    ]);

    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(5); // header + 3 rows + empty string after the final CRLF
    expect(lines[1].startsWith("First,")).toBe(true);
    expect(lines[2].startsWith("Second,")).toBe(true);
    expect(lines[3].startsWith("Third,")).toBe(true);
    expect(lines[4]).toBe("");
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("escapes commas, quotes and formula characters in name and email", () => {
    const csv = formatAttendeesCsv([row({ name: 'Lovelace, "Ada"', email: "=cmd|' /C calc'!A0" })]);

    // The email needs no CSV quoting once neutralised: single quotes aren't special.
    expect(csv).toContain(`"Lovelace, ""Ada""",'=cmd|' /C calc'!A0,REGISTERED,`);
  });

  it("keeps a name containing a line break inside one quoted cell", () => {
    const csv = formatAttendeesCsv([row({ name: "Ada\nLovelace" })]);

    expect(csv).toContain('"Ada\nLovelace",ada@example.com');
  });
});

describe("buildAttendeesCsvFilename", () => {
  it("builds a lowercase hyphenated slug from the title", () => {
    expect(buildAttendeesCsvFilename("Tech Meetup 2026", "evt-1")).toBe(
      "attendees-tech-meetup-2026.csv",
    );
  });

  it("strips accents instead of turning them into hyphens", () => {
    expect(buildAttendeesCsvFilename("Café Lumière", "evt-1")).toBe("attendees-cafe-lumiere.csv");
  });

  it("collapses punctuation and trims leading/trailing hyphens", () => {
    expect(buildAttendeesCsvFilename("  --Hello, World!!  ", "evt-1")).toBe(
      "attendees-hello-world.csv",
    );
  });

  it("truncates long titles without leaving a trailing hyphen", () => {
    const filename = buildAttendeesCsvFilename(`${"a".repeat(39)} bbbbbb`, "evt-1");

    expect(filename).toBe(`attendees-${"a".repeat(39)}.csv`);
  });

  it("falls back to the event id when nothing usable is left", () => {
    expect(buildAttendeesCsvFilename("会議", "evt-1")).toBe("attendees-evt-1.csv");
    expect(buildAttendeesCsvFilename("", "evt-1")).toBe("attendees-evt-1.csv");
    expect(buildAttendeesCsvFilename("!!!", "evt-1")).toBe("attendees-evt-1.csv");
  });

  it("never lets quotes or line breaks from the title reach the header value", () => {
    const filename = buildAttendeesCsvFilename('x"; evil\r\nSet-Cookie: a=b', "evt-1");

    expect(filename).toBe("attendees-x-evil-set-cookie-a-b.csv");
    expect(filename).toMatch(/^[a-z0-9.-]+$/);
  });
});
