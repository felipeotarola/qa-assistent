import { defineSchedule } from 'eve/schedules';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineSchedule({ cron: '* * * * *', async run() {
  const response = await fetch(`${appOrigin()}/api/internal/mission-reports/drain`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(210000) });
  if (!response.ok) throw new Error(`Mission report queue HTTP ${response.status}`);
} });
