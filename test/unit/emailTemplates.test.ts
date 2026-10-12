import { buildAppUrl } from "../../src/email/appUrl";
import {
  escapeHtml,
  eventCancellationEmail,
  eventReminderEmail,
  formatEventDay,
  formatEventWhen,
  passwordResetEmail,
  registrationConfirmationEmail,
  waitlistJoinedEmail,
  waitlistPromotionEmail,
  type EmailContent,
  type EmailEvent,
} from "../../src/email/templates";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.APP_BASE_URL = "https://attendly.example.test";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// 23:00Z on 7 Nov 2026 is 6:00 PM in New York (EST, DST ended 1 Nov).
const EVENT: EmailEvent = {
  id: "evt-1",
  title: "Tech Meetup",
  startTime: new Date("2026-11-07T23:00:00.000Z"),
  endTime: new Date("2026-11-08T02:00:00.000Z"),
  timezone: "America/New_York",
  venueName: "Test Hall",
  address: "123 Test St",
  city: "Testville",
};

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("leaves plain text alone", () => {
    expect(escapeHtml("Ada Lovelace 会議 José")).toBe("Ada Lovelace 会議 José");
  });
});

describe("formatEventWhen", () => {
  it("renders in the event's own timezone", () => {
    expect(formatEventWhen(EVENT)).toBe("Saturday, November 7, 2026, 6:00 PM EST – 9:00 PM EST");
  });

  it("follows the event's timezone, not the server's", () => {
    expect(formatEventWhen({ ...EVENT, timezone: "America/Los_Angeles" })).toBe(
      "Saturday, November 7, 2026, 3:00 PM PST – 6:00 PM PST",
    );
  });

  it("repeats the date when the event ends on a later local day", () => {
    const overnight = { ...EVENT, endTime: new Date("2026-11-08T07:00:00.000Z") };

    expect(formatEventWhen(overnight)).toBe(
      "Saturday, November 7, 2026, 6:00 PM EST – Sunday, November 8, 2026, 2:00 AM EST",
    );
  });

  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    const text = formatEventWhen({ ...EVENT, timezone: "Not/A_Zone" });

    expect(text).toContain("11:00 PM UTC");
  });

  it("uses a plain space before AM/PM, never a narrow no-break space", () => {
    expect(formatEventWhen(EVENT)).not.toMatch(/\u202f/);
  });
});

describe("registrationConfirmationEmail", () => {
  let email: EmailContent;

  // Built per test, not in the describe body: that would run before the
  // beforeEach above has set APP_BASE_URL.
  beforeEach(() => {
    email = registrationConfirmationEmail({ userName: "Ada Lovelace", event: EVENT });
  });

  it("has a subject naming the event", () => {
    expect(email.subject).toBe("You're registered: Tech Meetup");
  });

  it("links to the event page on the frontend", () => {
    expect(email.html).toContain('href="https://attendly.example.test/events/evt-1"');
    expect(email.text).toContain("https://attendly.example.test/events/evt-1");
  });

  it("shows when and where, in the event's timezone", () => {
    expect(email.text).toContain("When: Saturday, November 7, 2026, 6:00 PM EST");
    expect(email.text).toContain("Where: Test Hall, 123 Test St, Testville");
    expect(email.html).toContain("6:00 PM EST");
    expect(email.html).toContain("Test Hall, 123 Test St, Testville");
  });

  it("greets the user by name", () => {
    expect(email.text).toContain("Hi Ada Lovelace,");
  });

  it("keeps the text version free of HTML", () => {
    expect(email.text).not.toMatch(/<[a-z][^>]*>/i);
  });
});

describe("HTML safety", () => {
  const hostile: EmailEvent = {
    ...EVENT,
    title: "Tom & Jerry's <Party>",
    venueName: "<img src=x onerror=alert(1)>",
  };
  let email: EmailContent;

  beforeEach(() => {
    email = registrationConfirmationEmail({ userName: "<b>Mallory</b>", event: hostile });
  });

  it("escapes user-supplied values in the HTML part", () => {
    expect(email.html).toContain("Tom &amp; Jerry&#39;s &lt;Party&gt;");
    expect(email.html).toContain("&lt;b&gt;Mallory&lt;/b&gt;");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("never lets user-supplied markup through unescaped", () => {
    expect(email.html).not.toContain("<b>Mallory</b>");
    expect(email.html).not.toContain("<Party>");
    expect(email.html).not.toContain("<img");
  });

  it("keeps the text part as plain, unescaped text", () => {
    expect(email.text).toContain("Tom & Jerry's <Party>");
  });

  it("strips line breaks from the subject so it can't inject header lines", () => {
    const injected = registrationConfirmationEmail({
      userName: "Ada",
      event: { ...EVENT, title: "Hi\r\nBcc: evil@example.com" },
    });

    expect(injected.subject).not.toMatch(/[\r\n]/);
  });
});

describe("waitlistJoinedEmail", () => {
  it("tells the user their position", () => {
    const email = waitlistJoinedEmail({ userName: "Ada", event: EVENT, position: 3 });

    expect(email.subject).toBe("You're on the waitlist: Tech Meetup");
    expect(email.text).toContain("You're number 3 on the waitlist.");
    expect(email.html).toContain("You&#39;re number 3 on the waitlist.");
  });

  it("copes with a missing position", () => {
    const email = waitlistJoinedEmail({ userName: "Ada", event: EVENT, position: null });

    expect(email.text).toContain("You're on the waitlist.");
    expect(email.text).not.toContain("number");
  });
});

describe("waitlistPromotionEmail", () => {
  it("says the user moved off the waitlist and is now registered", () => {
    const email = waitlistPromotionEmail({ userName: "Ada", event: EVENT });

    expect(email.subject).toBe("A spot opened up: Tech Meetup");
    expect(email.text).toContain("moved off the waitlist");
    expect(email.text).toContain("now registered");
    expect(email.text).toContain("https://attendly.example.test/events/evt-1");
  });
});

describe("eventCancellationEmail", () => {
  it("says the event was cancelled and when it was scheduled", () => {
    const email = eventCancellationEmail({ userName: "Ada", event: EVENT });

    expect(email.subject).toBe("Cancelled: Tech Meetup");
    expect(email.text).toContain("cancelled Tech Meetup");
    expect(email.text).toContain("scheduled for Saturday, November 7, 2026, 6:00 PM EST");
    expect(email.text).not.toContain("You're registered");
  });
});

describe("passwordResetEmail", () => {
  const resetUrl = "https://attendly.example.test/reset-password?token=abc123";

  it("contains the reset link in both parts and says it expires in 1 hour", () => {
    const email = passwordResetEmail({ userName: "Ada", resetUrl });

    expect(email.subject).toBe("Reset your Attendly password");
    expect(email.text).toContain(resetUrl);
    expect(email.html).toContain(`href="${resetUrl}"`);
    expect(email.text).toContain("expires in 1 hour");
  });

  it("escapes the link inside the HTML attribute", () => {
    const email = passwordResetEmail({
      userName: "Ada",
      resetUrl: "https://attendly.example.test/reset-password?token=a&next=1",
    });

    expect(email.html).toContain("token=a&amp;next=1");
  });
});

describe("buildAppUrl", () => {
  it("joins APP_BASE_URL and the path", () => {
    expect(buildAppUrl("/events/1")).toBe("https://attendly.example.test/events/1");
  });

  it("ignores trailing slashes and surrounding whitespace in APP_BASE_URL", () => {
    process.env.APP_BASE_URL = "  https://attendly.example.test//  ";

    expect(buildAppUrl("/events/1")).toBe("https://attendly.example.test/events/1");
  });

  it.each([undefined, "", "   "])(
    "falls back to a localhost default outside production when APP_BASE_URL is %p",
    (value) => {
      if (value === undefined) {
        delete process.env.APP_BASE_URL;
      } else {
        process.env.APP_BASE_URL = value;
      }

      expect(buildAppUrl("/events/1")).toBe("http://localhost:5173/events/1");
    },
  );

  it("refuses to build a link in production when APP_BASE_URL is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_BASE_URL;

    expect(() => buildAppUrl("/events/1")).toThrow("APP_BASE_URL");
  });

  it("works in production when APP_BASE_URL is set", () => {
    process.env.NODE_ENV = "production";

    expect(buildAppUrl("/events/1")).toBe("https://attendly.example.test/events/1");
  });
});

describe("formatEventDay", () => {
  it("gives the start day in the event's own timezone", () => {
    expect(formatEventDay(EVENT)).toBe("Saturday, November 7, 2026");
  });

  it("can land on a different calendar day in another timezone", () => {
    // 23:00Z on the 7th is already midday on the 8th in New Zealand.
    expect(formatEventDay({ ...EVENT, timezone: "Pacific/Auckland" })).toBe(
      "Sunday, November 8, 2026",
    );
  });

  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    expect(formatEventDay({ ...EVENT, timezone: "Not/A_Zone" })).toBe("Saturday, November 7, 2026");
  });
});

describe("eventReminderEmail", () => {
  it("names the event and its day in the subject", () => {
    const email = eventReminderEmail({ userName: "Ada Lovelace", event: EVENT });

    expect(email.subject).toBe("Reminder: Tech Meetup on Saturday, November 7, 2026");
  });

  it("gives when, where and a link, and greets the user by name", () => {
    const email = eventReminderEmail({ userName: "Ada Lovelace", event: EVENT });

    expect(email.text).toContain("Hi Ada Lovelace, a reminder that Tech Meetup is coming up.");
    expect(email.text).toContain("When: Saturday, November 7, 2026, 6:00 PM EST");
    expect(email.text).toContain("Where: Test Hall, 123 Test St, Testville");
    expect(email.html).toContain('href="https://attendly.example.test/events/evt-1"');
  });

  it("never says how many hours away the event is (a reminder can go out late)", () => {
    const email = eventReminderEmail({ userName: "Ada", event: EVENT });

    expect(email.text).not.toMatch(/\bhours?\b/);
    expect(email.html).not.toMatch(/\bhours?\b/);
  });

  it("escapes user-supplied values in the HTML and keeps the subject on one line", () => {
    const email = eventReminderEmail({
      userName: "<b>Mallory</b>",
      event: { ...EVENT, title: "Tom & <Jerry>\r\nBcc: evil@example.com" },
    });

    expect(email.html).toContain("&lt;b&gt;Mallory&lt;/b&gt;");
    expect(email.html).toContain("Tom &amp; &lt;Jerry&gt;");
    expect(email.html).not.toContain("<Jerry>");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
});
