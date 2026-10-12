import { createApp } from "./app";
import { startReminderJob } from "./jobs/reminderJob";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`Attendly API listening on port ${PORT}`);
  startReminderJob();
});
